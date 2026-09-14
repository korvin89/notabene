// Diff model: Changeset / FileDiff / Hunk (ARCHITECTURE.md §2).
//
// This is an internal representation, independent of the source (git or
// file-history) and of the viewer. T3/T4 populate it, T5 turns it into a unified
// patch for hunk's VCS adapter (`patchText` + `readFileSource`), T6 takes context
// lines from it.

/** Side of the diff: before the edit or after. A comment can hang on either. */
export type Side = "old" | "new";

export type HunkLineKind = "context" | "add" | "del";

export interface HunkLine {
	kind: HunkLineKind;
	/** 1-based number in the old version; null for added lines */
	oldLine: number | null;
	/** 1-based number in the new version; null for deleted lines */
	newLine: number | null;
	/** content without the leading `+`/`-`/space and without the newline */
	text: string;
}

export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** tail of the `@@ … @@` header (usually the function name), if the source provided it */
	heading?: string;
	lines: HunkLine[];
}

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface FileDiff {
	/** path relative to the changeset root, always with `/` */
	path: string;
	/** previous path in case of a rename */
	previousPath?: string;
	changeKind: FileChangeKind;
	/** binary: no hunks, the viewer shows a placeholder */
	binary: boolean;
	hunks: Hunk[];
	/**
	 * Full versions of both sides, if the source can provide them cheaply.
	 * hunk needs them for `readFileSource` (the exact old/new document, not just
	 * the hunks) — see docs/spike-hunk.md, question 1.
	 */
	oldText?: string;
	newText?: string;
}

/** What the switcher shows: the current state or a specific turn. */
export type ChangesetMode = "current" | "turn";

export interface Changeset {
	/** stable identifier: `current` or `T3` (also drives `session reload -- diff T3`) */
	id: string;
	mode: ChangesetMode;
	/** label for the UI and the batch header: `Turn T3 ("tweak the dagger balance…")` */
	label: string;
	/** turn number for mode === "turn" */
	turn?: number;
	/** snippet of the user's prompt of this turn (ARCHITECTURE.md §4.3) */
	promptSnippet?: string;
	/** root against which `FileDiff.path` values are given */
	root: string;
	files: FileDiff[];
}

export interface DiffSource {
	/** `current` | `turns` — appears in `ntb dump <source>` */
	readonly name: string;
	/**
	 * List of changesets in display order. For `current` it always has one
	 * element, for `turns` — the turns that actually changed files
	 * (ARCHITECTURE.md §4.3). An empty list is a valid answer (nothing to review).
	 */
	changesets(): Promise<Changeset[]>;
}
