// hunk comment mirror → our ReviewComment model (T5).
//
// The `notes.json` file is written by the extension (src/hunk-ext/index.ts)
// following a schema verified by a live run of flow B (DECISIONS.md D19): the
// path and coordinates come from `note_created`/`note_edited`, set membership
// and deletions from `note_changed`, joined by `id`. This is the other side of
// the contract: reading and translating into ReviewComment.
//
// hunk has no comment types (T1b), so question/blocker are encoded as a body
// prefix: `[q] …` / `[question] …` / `[b] …` / `[blocker] …`.
// No prefix — `change` (DECISIONS.md D8).

import { readFileSync } from "node:fs";
import { log } from "../io.ts";
import type { ReviewComment, CommentType } from "../model/review.ts";
import { notesPath, readHandoff } from "./handoff.ts";
import type { HunkHandoff } from "./handoff.ts";

export { mirrorPath } from "./handoff.ts";

/** A single mirror entry — what the extension writes. */
export interface MirrorNote {
	id: string;
	/** "user" — typed by hand in the TUI; "agent"/"ai" — someone else's notes, not ours */
	source?: string;
	file: string | null;
	side?: "old" | "new" | null;
	oldRange?: readonly [number, number] | null;
	newRange?: readonly [number, number] | null;
	body?: string;
}

/** null — no file (the viewer never started or the extension failed to load). */
export function readMirrorNotes(path: string): MirrorNote[] | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as MirrorNote[]) : null;
	} catch {
		log.warn(`comment mirror is corrupted (${path}) — assuming there are no comments.`);
		return null;
	}
}

const TYPE_PREFIX = /^\[(q|question|c|change|b|blocker)\]\s*/i;

function parseType(body: string): { type: CommentType; body: string } {
	const match = TYPE_PREFIX.exec(body);
	if (match === null) return { type: "change", body };
	const letter = (match[1] as string).toLowerCase()[0];
	const type: CommentType = letter === "q" ? "question" : letter === "b" ? "blocker" : "change";
	return { type, body: body.slice(match[0].length) };
}

/** Up to three lines downward from the anchor (the line itself plus the next two) out of the side's full text — §3.1, behind a flag. */
function contextLines(handoff: HunkHandoff | null, note: MirrorNote, side: "old" | "new", start: number): string[] {
	if (handoff === null || note.file === null) return [];
	// Search for the file starting from the open changeset: the user may have switched scopes.
	const ordered = [...handoff.changesets].sort((a, b) =>
		(b.id === handoff.activeId ? 1 : 0) - (a.id === handoff.activeId ? 1 : 0),
	);
	for (const changeset of ordered) {
		const file = changeset.files.find((candidate) => candidate.path === note.file);
		if (file === undefined) continue;
		const text = side === "old" ? file.oldText : file.newText;
		if (text === null || text === undefined) return [];
		return text.split("\n").slice(Math.max(0, start - 1), start + 2);
	}
	return [];
}

/**
 * Collection shared by all launchers: mirror + handoff from the review state
 * directory (`<claudeDir>/notabene/<slug>/`, D30).
 * A missing mirror is not an error (the viewer may never have started) but an
 * empty review with a warning: empty stdout is a normal outcome per the spec.
 */
export function collectComments(dir: string): ReviewComment[] {
	// Every review has its own mirror name, and the handoff knows it; without a
	// handoff the legacy name remains (a session started by a previous version).
	const handoff = readHandoff(dir);
	const notes = readMirrorNotes(handoff?.notesPath ?? notesPath(dir));
	if (notes === null) {
		log.warn(
			"comment mirror not found — the viewer never started or the extension "
				+ "failed to load; assuming the review is empty.",
		);
		return [];
	}
	return notesToComments(notes, handoff);
}

/**
 * Translates the mirror into the review model. Only user notes with a file and
 * an anchor are taken; the order is as in the mirror (creation order).
 */
export function notesToComments(notes: MirrorNote[], handoff: HunkHandoff | null): ReviewComment[] {
	const comments: ReviewComment[] = [];
	for (const note of notes) {
		if ((note.source ?? "user") !== "user") continue;
		if (note.file === null || note.file === undefined) {
			log.warn(`comment ${note.id} has no file path — skipping.`);
			continue;
		}
		const side: "old" | "new" = note.side ?? (note.newRange != null ? "new" : "old");
		const range = (side === "old" ? note.oldRange : note.newRange) ?? note.oldRange ?? note.newRange;
		if (range == null) {
			log.warn(`comment ${note.id} (${note.file}) has no anchor — skipping.`);
			continue;
		}
		const { type, body } = parseType(note.body ?? "");
		if (body.trim() === "") continue;
		comments.push({
			id: note.id,
			file: note.file,
			side,
			startLine: range[0],
			endLine: range[1],
			hunk: null,
			type,
			body,
			context: contextLines(handoff, note, side, range[0]),
			status: "open",
			resolvedBy: null,
		});
	}
	return comments;
}
