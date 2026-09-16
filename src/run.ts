// The flow (ARCHITECTURE.md §1, §5):
//
//   !ntb → resolve the session → changesets (Current + T1..Tn) → handoff →
//           → launcher → block → collect → batch to stdout + JSON copy next to it
//
// Changesets are written into the handoff file wholesale — the hunk extension
// builds the turn switcher from it; the launcher only starts the viewer and waits.

import { createDiffSource, currentDiffSource, gitToplevel, isDiffSourceName } from "./diff/index.ts";
import type { DiffSourceName, DiffSourceOptions } from "./diff/index.ts";
import { TurnsSchemaError } from "./diff/jsonl.ts";
import { TurnsUnavailableError, buildTurnChangesets } from "./diff/turns.ts";
import { stdoutDelivery } from "./delivery/index.ts";
import { resolveHunkBinary } from "./hunk/bin.ts";
import { clearHandoff, handoffPath, readHandoff, reviewCancelled, writeHandoff } from "./hunk/handoff.ts";
import { collectComments } from "./hunk/notes.ts";
import { EXIT, ReviewError, emit, log } from "./io.ts";
import type { ExitCode } from "./io.ts";
import {
	BANG_DETACH_MS,
	DEFAULT_TIMEOUT_MS,
	detectEnvironment,
	explicitOpenLauncher,
	selectLauncher,
} from "./launcher/index.ts";
import type { LauncherName } from "./launcher/index.ts";
import type { Changeset } from "./model/diff.ts";
import { newReviewDocument } from "./model/review.ts";
import type { CommentStore, ReviewComment, ReviewDocument } from "./model/review.ts";
import { resolveSession } from "./session/index.ts";
import type { SessionContext, SessionInfo } from "./session/types.ts";
import { fileCommentStore } from "./store/index.ts";
import { localIsoTimestamp } from "./time.ts";

export type RunMode =
	/** one command: show, wait, print the batch (flows A/B) */
	| "auto"
	/** only prepare the review and open the viewer (flow C, step 1) */
	| "open"
	/** collect comments from an already-open viewer (flow C, step 2) */
	| "collect";

export interface RunOptions {
	mode: RunMode;
	/** turn number; null — the current state (`current`) */
	turn: number | null;
	timeoutMs: number;
	launcher: LauncherName | null;
	includeContext: boolean;
	ctx: SessionContext;
	signal: AbortSignal;
}

export async function run(options: RunOptions): Promise<ExitCode> {
	if (options.mode === "collect") return runCollect(options);
	if (options.mode === "open") {
		const prepared = await openPrepared(options);
		if (prepared !== null) return prepared;
		// no prepared review, but the session resolved — prepare from scratch below
	}

	const session = resolveSession(options.ctx);
	log.debug(
		`session ${session.sessionId} (${session.origin}), cwd=${session.cwd}, `
			+ `transcript=${session.transcriptPath ?? "not found"}`,
	);

	const root = await reviewRoot(session.cwd);
	const store = fileCommentStore(root);
	await ensureNoPending(store);
	// `ntb open` is an explicit ask to open the viewer here: no detection needed.
	const launcher = options.mode === "open"
		? explicitOpenLauncher({ env: options.ctx.env, cwd: root })
		: selectLauncher({
			env: options.ctx.env,
			cwd: root,
			...(options.launcher !== null ? { force: options.launcher } : {}),
		});

	const changesets = await buildAllChangesets(session, root, options);
	const changeset = changesets.length === 0 ? null : pickChangeset(changesets, options.turn);
	if (changeset === null) {
		log.info("No changes — nothing to review.");
		return EXIT.ok;
	}

	const document = newReviewDocument(session.sessionId, changeset, localIsoTimestamp());
	try {
		await store.savePending(document);
		// The local name is not `handoffPath`: that is the imported function's name.
		const handoffFile = writeHandoff(root, {
			changesets,
			activeId: changeset.id,
			hunkBin: resolveHunkBinary(options.ctx.env),
			stamp: document.createdAt,
		});
		await launcher.open({
			cwd: root,
			env: options.ctx.env,
			handoffPath: handoffFile,
			label: changeset.label,
		});
	} catch (error) {
		// The viewer did not open — there was no session, and its pending would
		// block every subsequent run (ensureNoPending) until a manual `collect`.
		// The handoff stays: with no pending nobody reads it, and it helps debugging.
		await store.clearPending();
		throw error;
	}

	// Flow C: the viewer lives on its own, nothing to wait for — exit with empty
	// stdout and say how to finish. Same for an explicit `open`.
	if (!launcher.blocking || options.mode === "open") {
		log.info("When you're done, run `ntb collect` in the Claude Code session — the batch will land in the context.");
		return EXIT.ok;
	}

	// A review almost always outlasts the caller's patience, so the user WILL see
	// "moved to the background" — and must know it is not a failure (docs/spike-tty.md,
	// probe 3). The ceiling is neither ours nor fixed: 120 s for a `!` command
	// (BANG_DETACH_MS), but whatever `timeout` the agent passed when the Bash tool
	// runs us — measured live at 600 s. So the warning names the effect and never a
	// number it cannot know.
	if (options.timeoutMs > BANG_DETACH_MS) {
		log.info(
			"Waiting for the viewer. Claude Code may stop waiting and move this command to the "
				+ "background before you are done — that is normal: the viewer stays open, and the "
				+ "comments arrive with the background-task completion notification.",
		);
	}

	const reason = await launcher.waitForDone({ timeoutMs: options.timeoutMs, signal: options.signal });
	switch (reason) {
		case "timeout":
			log.warn(
				`the viewer did not close within ${Math.round(options.timeoutMs / 60000)} min — exiting with empty `
					+ "stdout. The viewer is left open; `ntb collect` will pick up the comments.",
			);
			return EXIT.ok;
		case "interrupted":
			log.warn("interrupted; stdout is empty.");
			return EXIT.interrupted;
		default:
			break;
	}

	return finish(store, root, document, await launcher.collect(), options.includeContext);
}

/**
 * The review root: changeset paths and batch references are computed from it,
 * and `.claude/reviews/` lives in it. It is the git repository root, NOT the
 * session cwd: `git diff` prints paths from the root anyway, so for a session
 * started in a subdirectory a `@pkg/deep/file.ts` reference would match neither
 * Claude Code's cwd nor `handoff.root` (and the session files would land in the
 * subdirectory). Outside a repository the cwd itself remains.
 */
async function reviewRoot(cwd: string): Promise<string> {
	const toplevel = await gitToplevel(cwd);
	if (toplevel === null) return cwd;
	if (toplevel !== cwd) log.debug(`review root is ${toplevel} (session cwd: ${cwd})`);
	return toplevel;
}

/**
 * The handoff and the comment mirror in `.claude/reviews/` are per-repository,
 * so a new run on top of an unfinished session (the viewer is still open — here
 * or in a parallel session) would wipe its comments. Instead of a silent
 * overwrite — refuse and exit: `collect` will either deliver the batch or
 * dismiss an empty session.
 */
async function ensureNoPending(store: CommentStore): Promise<void> {
	const pending = await store.loadPending();
	if (pending === null) return;
	const subject = pending.source.mode === "turn"
		? `turn T${pending.source.turn ?? "?"}`
		: "the current state";
	throw new ReviewError(
		`there is already an unfinished review of ${subject} (started ${pending.createdAt}) — the viewer `
			+ "may still be open in this window or in a parallel session. Run `ntb collect` first: it "
			+ "will print that review's batch (or silently dismiss an empty session), then retry.",
	);
}

/**
 * An empty review is a normal outcome: stdout stays empty and Claude does
 * nothing (a spec requirement, ARCHITECTURE.md §3.1). So is a cancelled one —
 * the user pressed `x` in the viewer and the comments are deliberately dropped.
 */
async function finish(
	store: CommentStore,
	root: string,
	document: ReviewDocument,
	comments: ReviewComment[],
	includeContext: boolean,
): Promise<ExitCode> {
	if (reviewCancelled(root)) {
		const dropped = comments.length === 0
			? ""
			: ` — ${comments.length} comment${comments.length === 1 ? "" : "s"} discarded`;
		log.info(`Review cancelled in the viewer${dropped}; stdout is empty.`);
		await store.clearPending();
		clearHandoff(root);
		return EXIT.ok;
	}

	if (comments.length === 0) {
		log.info("No comments — stdout is empty.");
		await store.clearPending();
		clearHandoff(root);
		return EXIT.ok;
	}

	const filled: ReviewDocument = { ...document, comments };
	const jsonPath = await store.saveFinal(filled);
	await stdoutDelivery().deliver(filled, { jsonPath, includeContext });
	await store.clearPending();
	// The comments are already in the model and the JSON copy: session files can go.
	clearHandoff(root);
	return EXIT.ok;
}

/**
 * Comment collection (`collect` and the tail of flow C). No launcher needed:
 * the comment mirror is read the same way for every flow from the review directory.
 */
async function runCollect(options: RunOptions): Promise<ExitCode> {
	const cwd = await resolveReviewRoot(options, "the batch reaches Claude only via `ntb collect`");
	const store = fileCommentStore(cwd);
	const pending = await store.loadPending();
	if (pending === null) {
		throw new ReviewError(
			"nothing to collect: no unfinished review session found. Run `/ntb` or `ntb open` first.",
		);
	}
	return finish(store, cwd, pending, collectComments(cwd), options.includeContext);
}

/**
 * Step 2 of flow C: `ntb open` in a second terminal. The review is already
 * prepared (`!ntb` wrote pending and the handoff); a Claude Code session is
 * not needed here — and usually not available (no claude among the second
 * terminal's ancestors).
 * null — no prepared review, but there is a session: prepare from scratch in run().
 */
async function openPrepared(options: RunOptions): Promise<ExitCode | null> {
	let cwd: string;
	let sessionError: ReviewError | null = null;
	try {
		cwd = resolveSession(options.ctx).cwd;
	} catch (error) {
		if (!(error instanceof ReviewError)) throw error;
		sessionError = error;
		cwd = options.ctx.cwd;
	}
	cwd = await reviewRoot(cwd);

	const store = fileCommentStore(cwd);
	const pending = await store.loadPending();
	const handoff = readHandoff(cwd);
	if (pending === null || handoff === null) {
		if (sessionError !== null) {
			throw new ReviewError(
				`no prepared review in ${cwd}, and the session could not be resolved. `
					+ "Run `/ntb` in the Claude Code session first — then `ntb open` here.",
			);
		}
		return null;
	}

	if (options.turn !== null && pending.source.turn !== options.turn) {
		const prepared = pending.source.turn === null ? "the current state" : `turn T${pending.source.turn}`;
		log.warn(
			`the review is already prepared for ${prepared} — ignoring --turn ${options.turn} `
				+ `(to switch turns: !ntb --turn ${options.turn}).`,
		);
	}

	const active = handoff.changesets.find((changeset) => changeset.id === handoff.activeId);
	const launcher = explicitOpenLauncher({ env: options.ctx.env, cwd });
	await launcher.open({
		cwd,
		env: options.ctx.env,
		handoffPath: handoffPath(cwd),
		label: active?.label ?? "prepared review",
	});
	log.info("When you're done, run `ntb collect` in the Claude Code session — the batch will land in the context.");
	return EXIT.ok;
}

/** The review root from the session cwd; with no session — from the current directory, with a warning. */
async function resolveReviewRoot(options: RunOptions, consequence: string): Promise<string> {
	try {
		return await reviewRoot(resolveSession(options.ctx).cwd);
	} catch (error) {
		if (!(error instanceof ReviewError)) throw error;
		log.warn(`session not resolved — working with the current directory; ${consequence}.`);
		return reviewRoot(options.ctx.cwd);
	}
}

/**
 * The full list for the turn switcher: Current + T1..Tn (ARCHITECTURE.md §4.3).
 * Turns are included only if the transcript was found and file-history is intact;
 * their absence is not an error but a narrowing of the switcher down to Current.
 */
async function buildAllChangesets(
	session: SessionInfo,
	root: string,
	options: RunOptions,
): Promise<Changeset[]> {
	const sourceOptions: DiffSourceOptions = {
		cwd: root,
		session,
		claudeDir: options.ctx.claudeDir,
	};
	const current = await currentDiffSource(sourceOptions).changesets();

	if (session.transcriptPath === null) {
		const message = "per-turn diff unavailable: session transcript not found";
		if (options.turn !== null) log.warn(`${message}.`);
		else log.debug(message);
		return current;
	}
	try {
		return [...current, ...buildTurnChangesets(sourceOptions)];
	} catch (error) {
		if (error instanceof TurnsSchemaError || error instanceof TurnsUnavailableError) {
			log.warn(`per-turn diff unavailable: ${error.message} — the switcher has only the current state.`);
			return current;
		}
		throw error;
	}
}

/** null — nothing to review (a nonexistent turn stays an error for `--turn`). */
function pickChangeset(changesets: Changeset[], turn: number | null): Changeset | null {
	if (turn === null) {
		// `!ntb` with no flags reviews Current; the turns ride along for the switcher.
		return changesets.find((changeset) => changeset.mode === "current") ?? null;
	}

	const found = changesets.find((changeset) => changeset.turn === turn);
	if (found !== undefined) return found;

	const available = changesets
		.filter((changeset) => changeset.turn !== undefined)
		.map((changeset) => `T${changeset.turn}`)
		.join(", ");
	throw new ReviewError(
		`turn T${turn} is not among those that changed files${available === "" ? "" : `; there are: ${available}`}`,
		EXIT.usage,
	);
}

/** `ntb dump <source>` — debugging; JSON to stdout is its result. */
export async function dump(what: string, options: RunOptions): Promise<ExitCode> {
	if (what === "env") {
		emit(JSON.stringify(detectEnvironment(options.ctx.env), null, 2));
		return EXIT.ok;
	}
	if (what === "session") {
		emit(JSON.stringify(resolveSession(options.ctx), null, 2));
		return EXIT.ok;
	}
	if (!isDiffSourceName(what)) {
		throw new ReviewError(
			`unknown source for dump: ${what} (available: current, turns, session, env)`,
			EXIT.usage,
		);
	}

	const session = resolveSession(options.ctx);
	const source = createDiffSource(what, {
		cwd: await reviewRoot(session.cwd),
		session,
		claudeDir: options.ctx.claudeDir,
	});
	emit(JSON.stringify(await source.changesets(), null, 2));
	return EXIT.ok;
}

export { DEFAULT_TIMEOUT_MS };
