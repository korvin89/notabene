// Edge-case markup for the unified-patch parser (src/diff/parse.ts) that is
// inconvenient to get out of live git — the rest of the parser is exercised
// through the repository fixtures in diff-scopes.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseGitPatch } from "../src/diff/parse.ts";

describe("parseGitPatch", () => {
	test("quotes in a path (C-quoting) are removed", () => {
		const patch = [
			'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"',
			"index 0000000..1111111 100644",
			'--- "a/we\\"ird.txt"',
			'+++ "b/we\\"ird.txt"',
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		const files = parseGitPatch(patch);
		assert.equal(files.length, 1);
		assert.equal(files[0]?.path, 'we"ird.txt');
		assert.equal(files[0]?.hunks.length, 1);
	});

	test('a body line starting with "---" is not confused with a header', () => {
		const patch = [
			"diff --git a/doc.md b/doc.md",
			"index 0000000..1111111 100644",
			"--- a/doc.md",
			"+++ b/doc.md",
			"@@ -1,2 +1,3 @@",
			" header",
			"---- separator",
			"+--- separator",
			"+tail",
			"",
		].join("\n");
		const file = parseGitPatch(patch)[0];
		assert.deepEqual(file?.hunks[0]?.lines, [
			{ kind: "context", oldLine: 1, newLine: 1, text: "header" },
			{ kind: "del", oldLine: 2, newLine: null, text: "--- separator" },
			{ kind: "add", oldLine: null, newLine: 2, text: "--- separator" },
			{ kind: "add", oldLine: null, newLine: 3, text: "tail" },
		]);
	});

	test('mode-only change with a space in the name: path from "diff --git"', () => {
		const patch = [
			"diff --git a/bin/run me.sh b/bin/run me.sh",
			"old mode 100644",
			"new mode 100755",
			"",
		].join("\n");
		const file = parseGitPatch(patch)[0];
		assert.equal(file?.path, "bin/run me.sh");
		assert.equal(file?.changeKind, "modified");
		assert.deepEqual(file?.hunks, []);
	});

	test('"\\ No newline at end of file" does not end up in hunk lines', () => {
		const patch = [
			"diff --git a/x b/x",
			"index 0000000..1111111 100644",
			"--- a/x",
			"+++ b/x",
			"@@ -1 +1 @@",
			"-a",
			"\\ No newline at end of file",
			"+b",
			"\\ No newline at end of file",
			"",
		].join("\n");
		const file = parseGitPatch(patch)[0];
		assert.deepEqual(file?.hunks[0]?.lines, [
			{ kind: "del", oldLine: 1, newLine: null, text: "a" },
			{ kind: "add", oldLine: null, newLine: 1, text: "b" },
		]);
	});
});
