// Model of a review session and its store (ARCHITECTURE.md §3.2).
//
// The on-disk schema is a contract with the outside world (more than our code reads
// it), so `version` is fixed, and fields of the future cycle (`type`, `status`,
// `resolvedBy`) are present from day one, even while the UI does not fill them —
// a spec requirement.

import type { Changeset, ChangesetMode, Side } from "./diff.ts";

/** The MVP UI has no types (hunk does not have them) — encoded via a prefix, the field exists already. */
export type CommentType = "question" | "change" | "blocker";

export type CommentStatus = "open" | "resolved";

export interface ReviewComment {
	id: string;
	/** path relative to the changeset root */
	file: string;
	side: Side;
	/** 1-based, inclusive; for a single-line comment start === end */
	startLine: number;
	endLine: number;
	/** index of the hunk if the comment hangs on a hunk as a whole, otherwise null */
	hunk: number | null;
	type: CommentType;
	body: string;
	/** diff lines around the anchor; reach stdout only behind a flag (§3.1) */
	context: string[];
	status: CommentStatus;
	resolvedBy: string | null;
}

export interface ReviewSource {
	mode: ChangesetMode;
	/** turn number, or null for `current` */
	turn: number | null;
	sessionId: string;
	promptSnippet: string | null;
}

export interface ReviewDocument {
	version: 1;
	/** ISO-8601 with a timezone */
	createdAt: string;
	source: ReviewSource;
	comments: ReviewComment[];
}

/**
 * Store of a review session.
 *
 * Two states, because flow C (ARCHITECTURE.md §5.4) is split in time:
 * `ntb open` writes the pending document (what is being reviewed),
 * `ntb collect` reads it back — otherwise neither the turn nor the prompt
 * snippet would be known at collection time.
 */
export interface CommentStore {
	/** directory of machine-readable copies (by default `<repo>/.claude/reviews`) */
	readonly dir: string;
	loadPending(): Promise<ReviewDocument | null>;
	savePending(doc: ReviewDocument): Promise<void>;
	clearPending(): Promise<void>;
	/** final copy; returns the path of the written file (also in the batch tail) */
	saveFinal(doc: ReviewDocument): Promise<string>;
}

/** An empty document for the chosen changeset — filled with comments at collection. */
export function newReviewDocument(
	sessionId: string,
	changeset: Changeset,
	createdAt: string,
): ReviewDocument {
	return {
		version: 1,
		createdAt,
		source: {
			mode: changeset.mode,
			turn: changeset.turn ?? null,
			sessionId,
			promptSnippet: changeset.promptSnippet ?? null,
		},
		comments: [],
	};
}
