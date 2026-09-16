// Model of a review session and its store (ARCHITECTURE.md §3.2).
//
// The on-disk schema is a contract with the outside world (more than our code reads
// it), so `version` is fixed, and fields of the future cycle (`type`, `status`,
// `resolvedBy`) are present from day one, even while the UI does not fill them —
// a spec requirement.

import type { Changeset, ScopeId, Side } from "./diff.ts";

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
	/** which comparison was reviewed (ARCHITECTURE.md §4.2) */
	scope: ScopeId;
	/** what it was compared against, as the user named it: `HEAD`, `main`, `HEAD~3..HEAD` */
	against: string | null;
	sessionId: string;
}

/**
 * The scope in words — the subject of the batch header (§3.1) and of the
 * "there is already an unfinished review of …" refusal, so the two cannot drift.
 *
 * The fallback arm is not dead code: a pending document is read back by whatever
 * version runs `collect`, and one written before D31 carries no `scope` at all.
 */
export function describeSource(source: ReviewSource): string {
	switch (source.scope) {
		case "worktree":
			return "the working tree diff";
		case "staged":
			return "the staged diff";
		case "since":
			return source.against === null ? "the diff since the base branch" : `the diff since ${source.against}`;
		case "range":
			return source.against === null ? "the diff" : `the ${source.against} diff`;
		default:
			return "the diff";
	}
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
 * `ntb collect` reads it back — otherwise the scope would not be known at
 * collection time, and the batch header would have nothing to name.
 */
export interface CommentStore {
	/** the review state directory — `<claudeDir>/notabene/<slug>/`, outside the tree (D30) */
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
			scope: changeset.id,
			against: changeset.against,
			sessionId,
		},
		comments: [],
	};
}
