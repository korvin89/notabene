// The flow (ARCHITECTURE.md §1, §5):
//
//   !ntb → resolve the session → scopes (working tree, staged, since <base>) →
//           → handoff → launcher → block → collect → batch to stdout + JSON copy
//
// Two directories travel together through this file and must not be confused:
// `root` is the review root (the repository — patch paths and batch references
// are computed from it), `stateDir` is where our own files live, outside the
// tree (D30).
//
// Changesets are written into the handoff file wholesale — the hunk extension
// builds the scope picker from it; the launcher only starts the viewer and waits.

import { buildScopes, gitToplevel } from "./diff/scopes.ts";
import type { ScopeRequest } from "./diff/scopes.ts";
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
import { describeSource, newReviewDocument } from "./model/review.ts";
import type { CommentStore, ReviewComment, ReviewDocument } from "./model/review.ts";
import { resolveSession } from "./session/index.ts";
import type { SessionContext } from "./session/types.ts";
import { fileCommentStore, reviewStateDir } from "./store/index.ts";
import { migrateLegacyState } from "./store/migrate.ts";
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
	/** scope asked for on the command line; null — let the run pick (§4.2) */
	scope: ScopeRequest | null;
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
	log.debug(`session ${session.sessionId} (${session.origin}), cwd=${session.cwd}`);

	const root = await reviewRoot(session.cwd);
	const stateDir = resolveStateDir(root, options.ctx.claudeDir);
	const store = fileCommentStore(stateDir);
	await ensureNoPending(store);
	// `ntb open` is an explicit ask to open the viewer here: no detection needed.
	const launcher = options.mode === "open"
		? explicitOpenLauncher({ env: options.ctx.env, stateDir })
		: selectLauncher({
			env: options.ctx.env,
			stateDir,
			...(options.launcher !== null ? { force: options.launcher } : {}),
		});

	const { changesets, activeId } = await buildScopes({
		cwd: root,
		claudeDir: options.ctx.claudeDir,
		request: options.scope,
	});
	const changeset = changesets.find((candidate) => candidate.id === activeId) ?? null;
	if (changeset === null) {
		log.info(`${nothingToReview(options.scope)} — nothing to review.`);
		return EXIT.ok;
	}

	const document = newReviewDocument(session.sessionId, changeset, localIsoTimestamp());
	try {
		await store.savePending(document);
		// The local name is not `handoffPath`: that is the imported function's name.
		const handoffFile = writeHandoff(stateDir, {
			root,
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

	return finish(store, stateDir, document, await launcher.collect(), options.includeContext);
}

/**
 * The review root: changeset paths and batch references are computed from it.
 * It is the git repository root, NOT the session cwd: `git diff` prints paths
 * from the root anyway, so for a session started in a subdirectory a
 * `@pkg/deep/file.ts` reference would match neither Claude Code's cwd nor
 * `handoff.root`. Outside a repository the cwd itself remains.
 */
async function reviewRoot(cwd: string): Promise<string> {
	const toplevel = await gitToplevel(cwd);
	if (toplevel === null) return cwd;
	if (toplevel !== cwd) log.debug(`review root is ${toplevel} (session cwd: ${cwd})`);
	return toplevel;
}

/**
 * Where our own files live — outside the reviewed tree (D30). Every entry point
 * goes through here, which is also the one place that carries a pre-D30 in-tree
 * directory over; a review prepared before the upgrade would otherwise be
 * unreachable for `collect`.
 */
function resolveStateDir(root: string, claudeDir: string): string {
	const dir = reviewStateDir(root, claudeDir);
	migrateLegacyState(root, dir);
	log.debug(`review state: ${dir} (root: ${root})`);
	return dir;
}

/**
 * The handoff and the comment mirror are per-repository,
 * so a new run on top of an unfinished session (the viewer is still open — here
 * or in a parallel session) would wipe its comments. Instead of a silent
 * overwrite — refuse and exit: `collect` will either deliver the batch or
 * dismiss an empty session.
 */
async function ensureNoPending(store: CommentStore): Promise<void> {
	const pending = await store.loadPending();
	if (pending === null) return;
	throw new ReviewError(
		`there is already an unfinished review of ${describeSource(pending.source)} `
			+ `(started ${pending.createdAt}) — the viewer `
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
	stateDir: string,
	document: ReviewDocument,
	comments: ReviewComment[],
	includeContext: boolean,
): Promise<ExitCode> {
	if (reviewCancelled(stateDir)) {
		const dropped = comments.length === 0
			? ""
			: ` — ${comments.length} comment${comments.length === 1 ? "" : "s"} discarded`;
		log.info(`Review cancelled in the viewer${dropped}; stdout is empty.`);
		await store.clearPending();
		clearHandoff(stateDir);
		return EXIT.ok;
	}

	if (comments.length === 0) {
		log.info("No comments — stdout is empty.");
		await store.clearPending();
		clearHandoff(stateDir);
		return EXIT.ok;
	}

	const filled: ReviewDocument = { ...document, comments };
	const jsonPath = await store.saveFinal(filled);
	await stdoutDelivery().deliver(filled, { jsonPath, includeContext });
	await store.clearPending();
	// The comments are already in the model and the JSON copy: session files can go.
	clearHandoff(stateDir);
	return EXIT.ok;
}

/**
 * Comment collection (`collect` and the tail of flow C). No launcher needed:
 * the comment mirror is read the same way for every flow from the review directory.
 */
async function runCollect(options: RunOptions): Promise<ExitCode> {
	const root = await resolveReviewRoot(options, "the batch reaches Claude only via `ntb collect`");
	const stateDir = resolveStateDir(root, options.ctx.claudeDir);
	const store = fileCommentStore(stateDir);
	const pending = await store.loadPending();
	if (pending === null) {
		throw new ReviewError(
			"nothing to collect: no unfinished review session found. Run `/ntb:review` or `ntb open` first.",
		);
	}
	return finish(store, stateDir, pending, collectComments(stateDir), options.includeContext);
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
	const stateDir = resolveStateDir(cwd, options.ctx.claudeDir);

	const store = fileCommentStore(stateDir);
	const pending = await store.loadPending();
	const handoff = readHandoff(stateDir);
	if (pending === null || handoff === null) {
		if (sessionError !== null) {
			throw new ReviewError(
				`no prepared review in ${cwd}, and the session could not be resolved. `
					+ "Run `/ntb:review` in the Claude Code session first — then `ntb open` here.",
			);
		}
		return null;
	}

	if (options.scope !== null && pending.source.scope !== options.scope.id) {
		log.warn(
			`the review is already prepared for ${describeSource(pending.source)} — ignoring the requested scope `
				+ "(switch it inside the viewer, or start over with `ntb collect` and a new run).",
		);
	}

	const active = handoff.changesets.find((changeset) => changeset.id === handoff.activeId);
	const launcher = explicitOpenLauncher({ env: options.ctx.env, stateDir });
	await launcher.open({
		cwd,
		env: options.ctx.env,
		handoffPath: handoffPath(stateDir),
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
 * Why the viewer is not opening — named after what was asked for, because "No
 * changes" in answer to `ntb --staged` reads as a bug in the tool rather than as
 * an empty index.
 */
function nothingToReview(request: ScopeRequest | null): string {
	if (request === null) return "No changes";
	switch (request.id) {
		case "staged":
			return "Nothing staged";
		case "since":
			return `No changes since ${request.ref}`;
		case "range":
			return `No changes between ${request.base} and ${request.head}`;
		default:
			return "No changes in the working tree";
	}
}

/** `ntb dump <what>` — debugging; JSON to stdout is its result. */
export async function dump(what: string, options: RunOptions): Promise<ExitCode> {
	if (what === "env") {
		emit(JSON.stringify(detectEnvironment(options.ctx.env), null, 2));
		return EXIT.ok;
	}
	if (what === "session") {
		emit(JSON.stringify(resolveSession(options.ctx), null, 2));
		return EXIT.ok;
	}
	if (what !== "scopes") {
		throw new ReviewError(`unknown source for dump: ${what} (available: scopes, session, env)`, EXIT.usage);
	}

	emit(JSON.stringify(
		await buildScopes({
			cwd: await reviewRoot(resolveSession(options.ctx).cwd),
			claudeDir: options.ctx.claudeDir,
			request: options.scope,
		}),
		null,
		2,
	));
	return EXIT.ok;
}

export { DEFAULT_TIMEOUT_MS };
