// Our hunk extension (T5): scope changesets + comment mirror + scope switching.
// Loaded by the viewer: `hunk diff --extension src/hunk-ext`.
//
// The file is deliberately self-contained: the hunk loader executes it and our
// modules are unavailable to it, so the handoff/notes schemas are duplicated
// here structurally (the canon is src/hunk/handoff.ts and src/hunk/notes.ts;
// test/hunk-ext.test.ts guards the sync). hunk's Extension API is experimental —
// the hunkdiff version is pinned exactly in package.json.
//
// Four parts:
// 1. VCS adapter: scope patches from the handoff file (path in the
//    NOTABENE_HANDOFF env var), the scope label — in `title`.
//    Mechanics verified in T1b.
// 2. Comment mirror — schema verified by a live run of flow B
//    (DECISIONS.md D19): path/sides/ranges from note_created/note_edited,
//    set membership and deletions from note_changed, joined by id, flushed on
//    shutdown (250 ms budget) — plus a write on every event so we don't depend
//    on it.
// 3. Scope switching: `<`/`>` — adjacent scope, `T` — pick from a list; the
//    mechanism is `hunk session reload --repo … -- diff <id>` (verified in
//    T1b); the new range comes back into load() of our own adapter. The three
//    commands are registered only when there is more than one scope — an
//    inert keybinding is worse than a missing one.
// 4. Finishing: `C` — complete (the comments go to Claude, same as quitting),
//    `x` — cancel, which asks for confirmation and writes the outcome marker
//    the CLI reads (DECISIONS.md D28).

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import type {
	ExtensionCommandContext,
	ExtensionReviewNote,
	ExtensionVcsFileSourceRequest,
	HunkExtensionAPI,
} from "hunkdiff/extension";

// ── structural copies of the schemas (canon — src/hunk/handoff.ts, src/hunk/notes.ts) ──

interface HandoffFile {
	path: string;
	previousPath?: string;
	oldText: string | null;
	newText: string | null;
}

interface HandoffChangeset {
	id: string;
	label: string;
	patchText: string;
	files: HandoffFile[];
}

interface Handoff {
	version: number;
	root: string;
	notesPath: string;
	outcomePath?: string;
	hunkBin: string;
	activeId: string;
	changesets: HandoffChangeset[];
}

interface MirrorNote {
	id: string;
	source: string;
	file: string | null;
	side: "old" | "new" | null;
	oldRange: readonly [number, number] | null;
	newRange: readonly [number, number] | null;
	body: string;
}

/** A "for the user" error: hunk recognizes it structurally, by name (no import). */
function userError(message: string, suggestions: string[]): Error {
	return Object.assign(new Error(message), { name: "HunkExtensionUserError", suggestions });
}

export default function claudeDiffExtension(hunk: HunkExtensionAPI): void {
	const handoffPath = process.env["NOTABENE_HANDOFF"];
	if (handoffPath === undefined || handoffPath === "") {
		// A regular hunk run without our CLI — silently stay out of the way.
		return;
	}

	let handoff: Handoff;
	try {
		handoff = JSON.parse(readFileSync(handoffPath, "utf8")) as Handoff;
	} catch (error) {
		hunk.log(`notabene: failed to read handoff (${handoffPath}): ${String(error)}`);
		return;
	}
	if (handoff.version !== 1 || !Array.isArray(handoff.changesets) || handoff.changesets.length === 0) {
		hunk.log("notabene: handoff has an unknown schema — extension disabled");
		return;
	}

	const ids = handoff.changesets.map((changeset) => changeset.id);
	let activeId = ids.includes(handoff.activeId) ? handoff.activeId : (ids[0] as string);

	// ── 1. VCS adapter ──────────────────────────────────────────────────────

	/**
	 * Rides along in the review title, which hunk paints in the menu bar (muted,
	 * right-hand side, shown by default) — the only always-visible place an
	 * extension can reach: the `?` help is built from a fixed list of built-in
	 * commands, and the menu shows ours only once it is open (DECISIONS.md D28).
	 * hunk appends its own file and line counts after this and clips the end, so
	 * the hint stays short.
	 */
	const KEYS_HINT = ids.length > 1
		? "[< >] scope  [C] complete  [x] cancel"
		: "[C] complete  [x] cancel";

	hunk.registerVcsAdapter({
		id: "notabene",
		name: "notabene",
		// Above the built-in git (baseline 0): on the same root we win.
		detectionPriority: 100,
		detect: () => ({ id: "notabene", repoRoot: handoff.root }),
		operations: {
			"working-tree-diff": {
				load: async (input) => {
					const wanted = input.range ?? activeId;
					const changeset = handoff.changesets.find((candidate) => candidate.id === wanted);
					if (changeset === undefined) {
						throw userError(`notabene: there is no scope "${wanted}" in this review.`, [
							`Available: ${ids.join(", ")}.`,
							"Switching: < and > — adjacent scope, T — list.",
						]);
					}
					activeId = changeset.id;
					return {
						repoRoot: handoff.root,
						sourceLabel: `notabene: ${changeset.id}`,
						title: `${changeset.label}  ${KEYS_HINT}`,
						patchText: changeset.patchText,
						readFileSource: async (request: ExtensionVcsFileSourceRequest) => {
							const file = changeset.files.find((candidate) => candidate.path === request.path);
							if (file === undefined) return null;
							return (request.side === "old" ? file.oldText : file.newText) ?? null;
						},
					};
				},
			},
		},
	});

	// ── 2. Comment mirror ───────────────────────────────────────────────────

	/** id → file path from the events that carry a path at all */
	const paths = new Map<string, string>();
	/** id → entry; insertion order = creation order */
	const rows = new Map<string, MirrorNote>();

	const flush = (): void => {
		const out = [...rows.values()].map((row) => ({ ...row, file: row.file ?? paths.get(row.id) ?? null }));
		// Via a temp file: a hunk killed mid-write would otherwise leave
		// truncated JSON, and to the CLI that is indistinguishable from
		// "there were no comments".
		const tmp = `${handoff.notesPath}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
			renameSync(tmp, handoff.notesPath);
		} catch (error) {
			hunk.log(`notabene: failed to write the mirror (${handoff.notesPath}): ${String(error)}`);
		}
	};
	try {
		mkdirSync(dirname(handoff.notesPath), { recursive: true });
	} catch {
		// flush() will complain itself if the directory still is not there
	}

	// The mirror may be left over from a previous opening of the SAME review
	// (flow C: `open`, q, remembered one more point, `open` again) — it must
	// be continued, not reset: hunk's memory no longer holds the previous
	// session's comments.
	try {
		const previous = JSON.parse(readFileSync(handoff.notesPath, "utf8")) as MirrorNote[];
		if (Array.isArray(previous)) {
			for (const row of previous) {
				if (row === null || typeof row !== "object" || typeof row.id !== "string") continue;
				rows.set(row.id, row);
				if (typeof row.file === "string") paths.set(row.id, row.file);
			}
		}
	} catch {
		// no mirror (the usual case) or it is broken — start from a clean slate
	}
	// The file is in place right away: to the CLI it is the "extension loaded" marker.
	flush();

	// The path and exact coordinates live here. draft: true — a draft still being typed.
	const remember = (note: ExtensionReviewNote): void => {
		if (note.draft) return;
		paths.set(note.id, note.filePath);
		const prev = rows.get(note.id);
		rows.set(note.id, {
			id: note.id,
			source: prev?.source ?? "user",
			file: note.filePath,
			side: note.side,
			oldRange: note.oldRange ?? null,
			newRange: note.newRange ?? null,
			body: note.body,
		});
		flush();
	};

	hunk.on("note_created", (payload) => remember(payload.note));
	hunk.on("note_edited", (payload) => remember(payload.note));

	// The authoritative ReviewStore set: creations, edits and DELETIONS.
	hunk.on("note_changed", (payload) => {
		if (payload.kind === "removed") {
			rows.delete(payload.note.id);
			paths.delete(payload.note.id);
		} else {
			const prev = rows.get(payload.note.id);
			rows.set(payload.note.id, {
				id: payload.note.id,
				source: payload.note.source,
				file: prev?.file ?? paths.get(payload.note.id) ?? null,
				side: prev?.side ?? payload.note.anchor.preferred?.side ?? null,
				oldRange: payload.note.anchor.oldRange ?? prev?.oldRange ?? null,
				newRange: payload.note.anchor.newRange ?? prev?.newRange ?? null,
				body: prev?.body ?? payload.note.summary,
			});
		}
		flush();
	});

	hunk.on("shutdown", () => flush());

	// ── 3. Scope switching ──────────────────────────────────────────────────

	// `session reload --repo <path>` does NOT find the session with a VCS
	// adapter: in the daemon registry repoRoot holds our sourceLabel, not the
	// path (found by a live run in T5). So we look up our own session by pid —
	// the extension lives in the hunk process itself, and `session list --json`
	// reports that pid.
	let cachedSid: string | null = null;
	const resolveSid = (): Promise<string | null> =>
		new Promise((resolve) => {
			if (cachedSid !== null) {
				resolve(cachedSid);
				return;
			}
			execFile(handoff.hunkBin, ["session", "list", "--json"], (error, stdout) => {
				if (error !== null) {
					resolve(null);
					return;
				}
				try {
					const sessions = (JSON.parse(stdout) as { sessions?: { sessionId?: string; pid?: number; cwd?: string }[] })
						.sessions ?? [];
					const own = sessions.find((session) => session.pid === process.pid)
						?? sessions.find((session) => session.cwd === handoff.root);
					cachedSid = own?.sessionId ?? null;
					resolve(cachedSid);
				} catch {
					resolve(null);
				}
			});
		});

	const reload = async (ctx: ExtensionCommandContext, targetId: string): Promise<void> => {
		const sid = await resolveSid();
		if (sid === null) {
			ctx.notify("notabene: could not find my session in the hunk daemon — cannot switch scopes", "error");
			return;
		}
		await new Promise<void>((resolve) => {
			execFile(handoff.hunkBin, ["session", "reload", sid, "--json", "--", "diff", targetId], (error) => {
				if (error !== null) {
					ctx.notify(`notabene: failed to switch scope: ${error.message}`, "error");
				}
				resolve();
			});
		});
	};

	const step = (ctx: ExtensionCommandContext, delta: number): Promise<void> => {
		const index = ids.indexOf(activeId) + delta;
		if (index < 0 || index >= ids.length) {
			ctx.notify(delta > 0 ? "notabene: this is the last scope" : "notabene: this is the first scope");
			return Promise.resolve();
		}
		return reload(ctx, ids[index] as string);
	};

	// A review of one scope has nothing to switch to, and hunk would happily bind
	// three keys that only ever say "this is the last scope".
	// hunk's `,`/`.` are taken by files, hence `<`/`>`.
	if (ids.length > 1) {
		hunk.registerCommand({ id: "prevScope", title: "Previous scope", key: "<" }, (ctx) => step(ctx, -1));
		hunk.registerCommand({ id: "nextScope", title: "Next scope", key: ">" }, (ctx) => step(ctx, 1));
		hunk.registerCommand({ id: "pickScope", title: "Pick a scope", key: "T" }, async (ctx) => {
			const labels = handoff.changesets.map((changeset) => changeset.label);
			const chosen = await ctx.dialogs.select({ title: "Which diff to show?", options: labels });
			if (chosen === null) return;
			const index = labels.indexOf(chosen);
			if (index >= 0) await reload(ctx, ids[index] as string);
		});
	}

	// ── 4. Finishing the review ─────────────────────────────────────────────

	// Only an explicit Cancel writes the marker the CLI reads; quitting any other
	// way (`q`, a closed window, a kill) still delivers the comments, as it did
	// before these two commands existed. `q` cannot be taken over: a chord already
	// owned by a built-in is dropped from an extension command with a warning
	// (hunk's buildExtensionAppCommands), and `hunk.app.quit` owns `q`.
	const outcomePath = handoff.outcomePath ?? handoff.notesPath.replace(/\.json$/, ".outcome.json");

	// A marker from a previous opening of the SAME review (flow C: cancel, then
	// `ntb open` again) must not decide this one.
	rmSync(outcomePath, { force: true });

	const quit = (ctx: ExtensionCommandContext): void => {
		// `hunk.app.quit` is publicToExtensions; false means the host refused it,
		// and the user still has `q`.
		if (!ctx.commands.execute("hunk.app.quit")) {
			ctx.notify("notabene: the viewer refused to close — press q", "error");
		}
	};

	hunk.registerCommand({ id: "completeReview", title: "Complete review (send comments)", key: "C" }, (ctx) => {
		flush();
		quit(ctx);
	});

	// `x`, not a neighbour of `q`: the key that throws the review away should not
	// sit next to the one that delivers it.
	hunk.registerCommand(
		{ id: "cancelReview", title: "Cancel review (discard comments)", key: ["x", "X"] },
		async (ctx) => {
			if (rows.size > 0) {
				const confirmed = await ctx.dialogs.confirm({
					title: `Discard ${rows.size} comment${rows.size === 1 ? "" : "s"} and cancel the review?`,
					body: "Nothing reaches Claude, and the comments are gone.",
					confirmLabel: "Cancel review",
					cancelLabel: "Keep reviewing",
				});
				if (!confirmed) return;
			}
			try {
				writeFileSync(outcomePath, `${JSON.stringify({ version: 1, outcome: "cancelled" }, null, 2)}\n`);
			} catch (error) {
				// Without the marker the CLI would deliver the comments anyway — the
				// opposite of what was just asked — so do not quit either.
				ctx.notify(
					`notabene: could not record the cancellation (${String(error)}) — the review is still open`,
					"error",
				);
				return;
			}
			quit(ctx);
		},
	);
}
