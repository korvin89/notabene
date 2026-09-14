// Diff model → git-style unified patch for the hunk VCS adapter (T5).
//
// hunk parses the patch with its own engine, so the format is exactly what
// `git diff` prints: a `diff --git` header, new/deleted/rename markers,
// `---`/`+++`, hunks `@@ -a,b +c,d @@`. The exact old/new documents travel
// separately via `readFileSource` (FileDiff.oldText/newText), so the patch is
// only responsible for the set of changes and their markup.
//
// Deliberate simplification: we do not write the `\ No newline at end of file`
// marker — our Hunk model does not store the trailing newline. Rendering is
// unaffected, and hunk takes the exact texts from readFileSource.

import type { Changeset, FileDiff, Hunk } from "../model/diff.ts";

function hunkHeader(hunk: Hunk): string {
	const heading = hunk.heading === undefined || hunk.heading === "" ? "" : ` ${hunk.heading}`;
	return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${heading}`;
}

function hunkLines(hunk: Hunk): string[] {
	const marks = { context: " ", add: "+", del: "-" } as const;
	return hunk.lines.map((line) => `${marks[line.kind]}${line.text}`);
}

export function buildFilePatch(file: FileDiff): string {
	const oldPath = file.previousPath ?? file.path;
	const lines: string[] = [`diff --git a/${oldPath} b/${file.path}`];

	switch (file.changeKind) {
		case "added":
			lines.push("new file mode 100644");
			break;
		case "deleted":
			lines.push("deleted file mode 100644");
			break;
		case "renamed":
			lines.push(`rename from ${oldPath}`, `rename to ${file.path}`);
			break;
		default:
			break;
	}

	if (file.binary) {
		lines.push(`Binary files a/${oldPath} and b/${file.path} differ`);
		return `${lines.join("\n")}\n`;
	}

	if (file.hunks.length > 0) {
		lines.push(
			file.changeKind === "added" ? "--- /dev/null" : `--- a/${oldPath}`,
			file.changeKind === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}`,
		);
		for (const hunk of file.hunks) {
			lines.push(hunkHeader(hunk), ...hunkLines(hunk));
		}
	}

	return `${lines.join("\n")}\n`;
}

/** Patch for the whole changeset — concatenation of per-file patches, in model order. */
export function buildPatchText(changeset: Changeset): string {
	return changeset.files.map(buildFilePatch).join("");
}
