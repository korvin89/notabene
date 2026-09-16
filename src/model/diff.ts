// Diff model: Changeset / FileDiff / Hunk (ARCHITECTURE.md §2).
//
// This is an internal representation, independent of git and of the viewer. T3
// populates it, T5 turns it into a unified patch for hunk's VCS adapter
// (`patchText` + `readFileSource`), T6 takes context lines from it.

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

/**
 * Which git comparison a changeset shows (ARCHITECTURE.md §4.2). Doubles as the
 * changeset id: a review holds at most one changeset of each kind, and the id is
 * what `hunk session reload -- diff <id>` switches by.
 */
export type ScopeId = "worktree" | "staged" | "since" | "range";

export const SCOPE_IDS: readonly ScopeId[] = ["worktree", "staged", "since", "range"];

export interface Changeset {
	id: ScopeId;
	/** label for the UI and the scope picker: `Working tree`, `Since main` */
	label: string;
	/**
	 * What the changeset is compared against, named the way the user named it
	 * (`HEAD`, `main`, `HEAD~3..HEAD`) — it reaches the batch header and the
	 * machine-readable copy. null outside a repository with commits.
	 */
	against: string | null;
	/** root against which `FileDiff.path` values are given */
	root: string;
	files: FileDiff[];
}
