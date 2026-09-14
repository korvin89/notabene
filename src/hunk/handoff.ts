// Handoff — the contract between the CLI and our hunk extension (T5).
//
// The CLI builds changesets and writes them to `<repo>/.claude/reviews/handoff.json`;
// the file path travels to the viewer via the `NOTABENE_HANDOFF` env var.
// The extension (src/hunk-ext/index.ts) reads the handoff, serves patches to
// hunk through a VCS adapter and mirrors comments into `notesPath`. The
// extension is self-contained (the hunk loader executes it, our modules are
// unavailable to it), so it duplicates the schema structurally;
// test/hunk-ext.test.ts guards the sync.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewsDir } from "../store/index.ts";
import type { Changeset } from "../model/diff.ts";
import { buildPatchText } from "./patch.ts";

/** Name of the env var the launcher uses to pass the handoff to the viewer. */
export const HANDOFF_ENV = "NOTABENE_HANDOFF";

export interface HandoffFile {
	path: string;
	previousPath?: string;
	/** full texts of both sides for readFileSource; null — side absent/text unavailable */
	oldText: string | null;
	newText: string | null;
}

export interface HandoffChangeset {
	/** `current` | `T3` — also drives `hunk session reload -- diff <id>` */
	id: string;
	/** title in hunk: `Turn T3 ("fix the balance…")` */
	label: string;
	patchText: string;
	files: HandoffFile[];
}

export interface HunkHandoff {
	version: 1;
	/** changeset root — repoRoot for the VCS adapter */
	root: string;
	/** where the extension mirrors comments */
	notesPath: string;
	/** platform hunk binary — for the extension's `session reload` */
	hunkBin: string;
	/** id of the changeset to open first */
	activeId: string;
	changesets: HandoffChangeset[];
}

export function handoffPath(cwd: string): string {
	return join(reviewsDir(cwd), "handoff.json");
}

/**
 * Legacy name of the comment mirror (format — src/hunk/notes.ts). Kept as a
 * fallback for readers that have no handoff.
 */
export function notesPath(cwd: string): string {
	return join(reviewsDir(cwd), "notes.json");
}

/** Mirrors of every generation: the legacy name, the review-stamped name and the temp write file. */
const NOTES_PATTERN = /^notes(-.*)?\.json(\.tmp)?$/;

function removeMirrors(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (NOTES_PATTERN.test(name)) rmSync(join(dir, name), { force: true });
	}
}

/**
 * The session is closed (the batch was delivered or there were no comments):
 * nobody needs the handoff and the mirror any more, and the handoff is the
 * heaviest file in the directory — it holds the full texts of both sides of
 * every changeset (hundreds of kilobytes per turn, megabytes with the turn
 * switcher). The machine-readable review copies stay — they are history.
 */
export function clearHandoff(cwd: string): void {
	rmSync(handoffPath(cwd), { force: true });
	removeMirrors(reviewsDir(cwd));
}

/**
 * The mirror name is unique per review. A viewer left open (the normal timeout
 * outcome — `run.ts` deliberately leaves it alone) keeps writing to ITS OWN
 * file and cannot clobber the comments of the next review.
 */
function notesPathFor(cwd: string, stamp: string): string {
	return join(reviewsDir(cwd), `notes-${stamp.slice(0, 19).replace(/:/g, "-")}.json`);
}

/**
 * Where the current review's mirror lives: the handoff knows the name (it set
 * it in the first place); the legacy name is the fallback when there is no
 * handoff or it has a foreign schema.
 */
export function mirrorPath(cwd: string): string {
	return readHandoff(cwd)?.notesPath ?? notesPath(cwd);
}

function toHandoffChangeset(changeset: Changeset): HandoffChangeset {
	return {
		id: changeset.id,
		label: changeset.label,
		patchText: buildPatchText(changeset),
		files: changeset.files.map((file) => ({
			path: file.path,
			...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
			oldText: file.oldText ?? null,
			newText: file.newText ?? null,
		})),
	};
}

/**
 * Writes the handoff and removes comment mirrors of past reviews — otherwise
 * `collect` could pick up someone else's notes. Returns the handoff path.
 */
export function writeHandoff(
	cwd: string,
	options: { changesets: Changeset[]; activeId: string; hunkBin: string; stamp: string },
): string {
	const dir = reviewsDir(cwd);
	mkdirSync(dir, { recursive: true });
	// Nobody reads past reviews' mirrors any more (pending is cleared), and a
	// live viewer, if one is still open, simply recreates its own — on the next flush.
	removeMirrors(dir);

	const handoff: HunkHandoff = {
		version: 1,
		root: cwd,
		notesPath: notesPathFor(cwd, options.stamp),
		hunkBin: options.hunkBin,
		activeId: options.activeId,
		changesets: options.changesets.map(toHandoffChangeset),
	};
	const path = handoffPath(cwd);
	writeFileSync(path, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
	return path;
}

/** null — no handoff, or it has an unknown schema (no reason to fail collection). */
export function readHandoff(cwd: string): HunkHandoff | null {
	let raw: string;
	try {
		raw = readFileSync(handoffPath(cwd), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<HunkHandoff>;
		if (parsed.version !== 1 || !Array.isArray(parsed.changesets)) return null;
		return parsed as HunkHandoff;
	} catch {
		return null;
	}
}
