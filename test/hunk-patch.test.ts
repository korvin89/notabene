import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildFilePatch, buildPatchText } from "../src/hunk/patch.ts";
import type { Changeset, FileDiff } from "../src/model/diff.ts";

const modified: FileDiff = {
	path: "src/weapons.ts",
	changeKind: "modified",
	binary: false,
	hunks: [
		{
			oldStart: 1,
			oldLines: 3,
			newStart: 1,
			newLines: 3,
			heading: "function hit",
			lines: [
				{ kind: "context", oldLine: 1, newLine: 1, text: "export const KB = 4;" },
				{ kind: "del", oldLine: 2, newLine: null, text: "export function hit(t) {" },
				{ kind: "add", oldLine: null, newLine: 2, text: "export function hit(t, kb) {" },
				{ kind: "context", oldLine: 3, newLine: 3, text: "}" },
			],
		},
	],
	oldText: "export const KB = 4;\nexport function hit(t) {\n}\n",
	newText: "export const KB = 4;\nexport function hit(t, kb) {\n}\n",
};

describe("buildFilePatch — git-style unified patch from the model", () => {
	test("modified file: header, ---/+++, hunk with counts and heading", () => {
		assert.equal(
			buildFilePatch(modified),
			[
				"diff --git a/src/weapons.ts b/src/weapons.ts",
				"--- a/src/weapons.ts",
				"+++ b/src/weapons.ts",
				"@@ -1,3 +1,3 @@ function hit",
				" export const KB = 4;",
				"-export function hit(t) {",
				"+export function hit(t, kb) {",
				" }",
				"",
			].join("\n"),
		);
	});

	test("added file: new file mode and --- /dev/null", () => {
		const added: FileDiff = {
			path: "notes.md",
			changeKind: "added",
			binary: false,
			hunks: [
				{
					oldStart: 0,
					oldLines: 0,
					newStart: 1,
					newLines: 1,
					lines: [{ kind: "add", oldLine: null, newLine: 1, text: "hello" }],
				},
			],
		};
		const patch = buildFilePatch(added);
		assert.match(patch, /^diff --git a\/notes\.md b\/notes\.md\nnew file mode 100644\n/);
		assert.match(patch, /--- \/dev\/null\n\+\+\+ b\/notes\.md\n@@ -0,0 \+1,1 @@\n\+hello\n$/);
	});

	test("deleted file: deleted file mode and +++ /dev/null", () => {
		const deleted: FileDiff = {
			path: "old.txt",
			changeKind: "deleted",
			binary: false,
			hunks: [
				{
					oldStart: 1,
					oldLines: 1,
					newStart: 0,
					newLines: 0,
					lines: [{ kind: "del", oldLine: 1, newLine: null, text: "bye" }],
				},
			],
		};
		const patch = buildFilePatch(deleted);
		assert.match(patch, /deleted file mode 100644\n/);
		assert.match(patch, /--- a\/old\.txt\n\+\+\+ \/dev\/null\n/);
	});

	test("rename: rename from/to, header with the old and new paths", () => {
		const renamed: FileDiff = {
			path: "b.txt",
			previousPath: "a.txt",
			changeKind: "renamed",
			binary: false,
			hunks: [],
		};
		assert.equal(
			buildFilePatch(renamed),
			"diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n",
		);
	});

	test("binary: Binary files … differ, no hunks", () => {
		const binary: FileDiff = { path: "logo.png", changeKind: "modified", binary: true, hunks: [] };
		assert.equal(
			buildFilePatch(binary),
			"diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
		);
	});

	test("empty added file: headers only, no ---/+++", () => {
		const empty: FileDiff = { path: "empty.txt", changeKind: "added", binary: false, hunks: [] };
		assert.equal(buildFilePatch(empty), "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n");
	});
});

describe("buildPatchText", () => {
	test("changeset patch — concatenation of per-file patches in model order", () => {
		const changeset: Changeset = {
			id: "T1",
			mode: "turn",
			label: "Turn T1 (\"test\")",
			turn: 1,
			root: "/tmp",
			files: [modified, { path: "empty.txt", changeKind: "added", binary: false, hunks: [] }],
		};
		const patch = buildPatchText(changeset);
		assert.ok(patch.indexOf("a/src/weapons.ts") < patch.indexOf("a/empty.txt"));
		assert.equal((patch.match(/^diff --git /gm) ?? []).length, 2);
	});
});
