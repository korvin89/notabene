// Review model fixture for the formatter snapshot tests — modeled on
// ARCHITECTURE.md §3.1 (4 comments: a range, the old side, a hunk anchor,
// a multi-line body).

import type { ReviewDocument } from "../../src/model/review.ts";

/** The path printed at the tail of the reference batch. */
export const FIXTURE_JSON_PATH = ".claude/reviews/2026-09-13T20-15-31.json";

export function reviewTurnFixture(): ReviewDocument {
	return {
		version: 1,
		createdAt: "2026-09-13T20:15:31+03:00",
		source: {
			mode: "turn",
			turn: 3,
			sessionId: "f5bf67f3-1234-4abc-8def-000000000001",
			promptSnippet: "fix the dagger balance, knockback…",
		},
		comments: [
			{
				id: "c1",
				file: "src/weapons.ts",
				side: "new",
				startLine: 42,
				endLine: 48,
				hunk: null,
				type: "change",
				body: "Knockback is hardcoded — move it into WEAPON_CONFIG.",
				context: ["  const KNOCKBACK = 4;", "  applyKnockback(target, KNOCKBACK);"],
				status: "open",
				resolvedBy: null,
			},
			{
				id: "c2",
				file: "src/balance.md",
				side: "old",
				startLine: 10,
				endLine: 10,
				hunk: null,
				type: "question",
				body: "Why was the crit item removed? It had been agreed on.",
				context: ["- crit: 2x on daggers"],
				status: "open",
				resolvedBy: null,
			},
			{
				id: "c3",
				file: "src/weapons.ts",
				side: "new",
				startLine: 90,
				endLine: 90,
				hunk: 2,
				type: "blocker",
				body: "This breaks old profile saves.",
				context: [],
				status: "open",
				resolvedBy: null,
			},
			{
				id: "c4",
				file: "src/save/profile.ts",
				side: "old",
				startLine: 17,
				endLine: 19,
				hunk: null,
				type: "change",
				body: "The old-profile migration should be restored:\nwithout it, pre-v3 saves are silently lost.",
				context: ["  if (profile.version < 3) {", "    migrate(profile);", "  }"],
				status: "open",
				resolvedBy: null,
			},
		],
	};
}

/** An empty review of the same turn: stdout must stay empty, no JSON is written. */
export function reviewEmptyFixture(): ReviewDocument {
	const doc = reviewTurnFixture();
	return { ...doc, comments: [] };
}
