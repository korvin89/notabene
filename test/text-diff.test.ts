// Unit tests of the line-based diff (T4). The key invariant: applying the hunks
// to the old text yields the new text — the "turn diff is correct" check in
// test/diff-turns.test.ts rests on the same invariant.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffTexts, splitLines } from "../src/diff/text-diff.ts";
import type { Hunk } from "../src/model/diff.ts";
import { applyHunks } from "./helpers.ts";

function check(oldText: string, newText: string): Hunk[] {
	const hunks = diffTexts(oldText, newText);
	assert.equal(applyHunks(oldText, hunks), splitLines(newText).join("\n"));
	return hunks;
}

describe("splitLines", () => {
	it("empty text — zero lines, not one empty line", () => {
		assert.deepEqual(splitLines(""), []);
	});
	it("a trailing newline does not produce a phantom line", () => {
		assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
		assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
		assert.deepEqual(splitLines("\n"), [""]);
	});
});

describe("diffTexts", () => {
	it("identical texts — no hunks", () => {
		assert.deepEqual(diffTexts("a\nb\n", "a\nb\n"), []);
	});

	it("line replacement: a single hunk with context and line numbers", () => {
		const hunks = check("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nX\ne\nf\ng\nh\n");
		assert.equal(hunks.length, 1);
		const hunk = hunks[0] as Hunk;
		assert.equal(hunk.oldStart, 1); // 3 lines of context run into the start of the file
		assert.deepEqual(
			hunk.lines.map((line) => `${line.kind}:${line.oldLine ?? "-"}:${line.newLine ?? "-"}:${line.text}`),
			[
				"context:1:1:a",
				"context:2:2:b",
				"context:3:3:c",
				"del:4:-:d",
				"add:-:4:X",
				"context:5:5:e",
				"context:6:6:f",
				"context:7:7:g",
			],
		);
	});

	it("new file: a pure add hunk with oldStart 0", () => {
		const hunks = check("", "x\ny\n");
		assert.equal(hunks.length, 1);
		const hunk = hunks[0] as Hunk;
		assert.equal(hunk.oldStart, 0);
		assert.equal(hunk.oldLines, 0);
		assert.equal(hunk.newStart, 1);
		assert.equal(hunk.newLines, 2);
		assert.ok(hunk.lines.every((line) => line.kind === "add"));
	});

	it("deleted file: a pure del hunk", () => {
		const hunks = check("x\ny\n", "");
		assert.equal(hunks.length, 1);
		assert.equal((hunks[0] as Hunk).newLines, 0);
		assert.ok((hunks[0] as Hunk).lines.every((line) => line.kind === "del"));
	});

	it("distant edits — separate hunks, close ones — merged", () => {
		const base = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
		const far = base.replace("line2", "LINE2").replace("line25", "LINE25");
		assert.equal(check(base, far).length, 2);
		const near = base.replace("line2", "LINE2").replace("line6", "LINE6");
		assert.equal(check(base, near).length, 1);
	});

	it("insertion at the end and at the beginning", () => {
		check("a\nb\n", "a\nb\nc\n");
		check("a\nb\n", "z\na\nb\n");
	});

	it("a fully rewritten file", () => {
		check("a\nb\nc\n", "x\ny\n");
	});

	it("random pairs are reconstructed exactly", () => {
		// a small deterministic fuzzer: LCG + mutations
		let seed = 42;
		const rand = (n: number): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};
		for (let round = 0; round < 25; round += 1) {
			const oldLines = Array.from({ length: rand(40) }, (_, i) => `s${i}-${rand(5)}`);
			const newLines = [...oldLines];
			for (let m = rand(10); m > 0; m -= 1) {
				const kind = rand(3);
				const at = newLines.length === 0 ? 0 : rand(newLines.length);
				if (kind === 0 && newLines.length > 0) newLines.splice(at, 1);
				else if (kind === 1) newLines.splice(at, 0, `ins-${round}-${m}`);
				else if (newLines.length > 0) newLines[at] = `mut-${round}-${m}`;
			}
			check(oldLines.join("\n"), newLines.join("\n"));
		}
	});
});
