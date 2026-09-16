// Snapshot tests for the stdout batch formatter (ARCHITECTURE.md §3.1).
// References live in test/fixtures/stdout-*.txt — compared character by character.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { STDOUT_LIMIT, formatReviewBatch } from "../src/delivery/index.ts";
import type { ReviewComment, ReviewDocument } from "../src/model/review.ts";
import type { ScopeId } from "../src/model/diff.ts";
import { FIXTURE_JSON_PATH, reviewEmptyFixture, reviewScopeFixture } from "./fixtures/review-scope.ts";

function snapshot(name: string): string {
	return readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
}

function comment(overrides: Partial<ReviewComment>): ReviewComment {
	return {
		id: "c1",
		file: "src/a.ts",
		side: "new",
		startLine: 1,
		endLine: 1,
		hunk: null,
		type: "change",
		body: "body",
		context: [],
		status: "open",
		resolvedBy: null,
		...overrides,
	};
}

function doc(comments: ReviewComment[], scope: ScopeId = "since", against = "main"): ReviewDocument {
	return {
		version: 1,
		createdAt: "2026-09-13T20:15:31+03:00",
		source: { scope, against, sessionId: "s" },
		comments,
	};
}

describe("stdout batch: snapshots", () => {
	test("fixture review without context — the §3.1 reference", () => {
		const batch = formatReviewBatch(reviewScopeFixture(), {
			jsonPath: FIXTURE_JSON_PATH,
			includeContext: false,
		});
		assert.equal(batch.text, snapshot("stdout-scope.txt"));
		assert.equal(batch.contextDropped, 0);
	});

	test("fixture review with context (--context)", () => {
		const batch = formatReviewBatch(reviewScopeFixture(), {
			jsonPath: FIXTURE_JSON_PATH,
			includeContext: true,
		});
		assert.equal(batch.text, snapshot("stdout-scope-context.txt"));
		assert.equal(batch.contextDropped, 0);
	});
});

describe("stdout batch: edge cases", () => {
	test("empty review → empty string (stdout stays empty, Claude stays silent)", () => {
		const batch = formatReviewBatch(reviewEmptyFixture(), {
			jsonPath: null,
			includeContext: true,
		});
		assert.equal(batch.text, "");
	});

	test("old side: the reference stays numeric, the exact anchor goes in parentheses", () => {
		const single = formatReviewBatch(
			doc([comment({ file: "src/balance.md", side: "old", startLine: 10, endLine: 10 })]),
			{ jsonPath: null, includeContext: false },
		);
		assert.match(single.text, /@src\/balance\.md:10 \[change\] \(deleted line, old:10\)/);

		const range = formatReviewBatch(
			doc([comment({ side: "old", startLine: 17, endLine: 19 })]),
			{ jsonPath: null, includeContext: false },
		);
		assert.match(range.text, /@src\/a\.ts:17-19 \[change\] \(deleted lines, old:17-19\)/);
	});

	test("every scope names itself in the header; the count stays grammatical", () => {
		const header = (scope: ScopeId, against: string): string =>
			formatReviewBatch(doc([comment({})], scope, against), { jsonPath: null, includeContext: false })
				.text.split("\n")[0] ?? "";

		assert.equal(header("worktree", "HEAD"), "Review of the working tree diff, 1 comment.");
		assert.equal(header("staged", "HEAD"), "Review of the staged diff, 1 comment.");
		assert.equal(header("since", "main"), "Review of the diff since main, 1 comment.");
		assert.equal(header("range", "HEAD~3..HEAD"), "Review of the HEAD~3..HEAD diff, 1 comment.");
	});

	test("a pending document from before D31 has no scope — the header degrades, not crashes", () => {
		const legacy = doc([comment({})]);
		// what `ntb collect` reads back after an upgrade mid-review
		legacy.source = { mode: "turn", turn: 3, sessionId: "s" } as unknown as ReviewDocument["source"];
		const batch = formatReviewBatch(legacy, { jsonPath: null, includeContext: false });
		assert.match(batch.text, /^Review of the diff, 1 comment\.\n/);
	});

	test("without jsonPath the \"Machine-readable copy\" tail is not printed", () => {
		const batch = formatReviewBatch(doc([comment({})]), { jsonPath: null, includeContext: false });
		assert.doesNotMatch(batch.text, /Machine-readable copy/);
	});

	test("no more than three context lines per item (§3.1: \"1–3 lines\")", () => {
		const batch = formatReviewBatch(
			doc([comment({ context: ["one", "two", "three", "four"] })]),
			{ jsonPath: null, includeContext: true },
		);
		assert.match(batch.text, /> three/);
		assert.doesNotMatch(batch.text, /> four/);
	});

	test("without --context no context is printed at all", () => {
		const batch = formatReviewBatch(
			doc([comment({ context: ["secret context"] })]),
			{ jsonPath: null, includeContext: false },
		);
		assert.doesNotMatch(batch.text, /secret context/);
	});
});

describe("stdout batch: the ~25k limit", () => {
	test("context is trimmed on trailing items, comments survive", () => {
		// 30 items, each with a ~2000-char context line: together they don't fit
		// the limit, so the trailing items are left without context.
		const comments = Array.from({ length: 30 }, (_, i) =>
			comment({
				id: `c${i + 1}`,
				startLine: i + 1,
				endLine: i + 1,
				body: `comment #${i + 1}`,
				context: [`ctx-${i + 1} ${"x".repeat(2000)}`],
			}));
		const batch = formatReviewBatch(doc(comments), {
			jsonPath: FIXTURE_JSON_PATH,
			includeContext: true,
		});

		assert.ok(batch.text.length <= STDOUT_LIMIT, `batch ${batch.text.length} > ${STDOUT_LIMIT}`);
		assert.ok(batch.contextDropped > 0, "the limit should have trimmed someone's context");
		assert.match(batch.text, /> ctx-1 /, "the first item's context must survive");
		for (let i = 1; i <= 30; i += 1) {
			assert.match(batch.text, new RegExp(`comment #${i}\\b`), `item ${i} lost`);
		}
		assert.match(batch.text, /Machine-readable copy: /);
	});

	test("comments themselves are never trimmed, even when the batch exceeds the limit", () => {
		const comments = Array.from({ length: 40 }, (_, i) =>
			comment({
				id: `c${i + 1}`,
				startLine: i + 1,
				endLine: i + 1,
				body: `comment #${i + 1}: ${"x".repeat(800)}`,
				context: ["context that no longer fits"],
			}));
		const batch = formatReviewBatch(doc(comments), { jsonPath: null, includeContext: true });

		assert.ok(batch.text.length > STDOUT_LIMIT, "the fixture must overflow the limit without context");
		for (let i = 1; i <= 40; i += 1) {
			assert.match(batch.text, new RegExp(`comment #${i}:`), `item ${i} lost`);
		}
		assert.equal(batch.contextDropped, 40);
		assert.doesNotMatch(batch.text, /context that no longer fits/);
	});
});
