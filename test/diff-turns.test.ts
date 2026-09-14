// Tests of the "turns" DiffSource (T4) on fixtures from REAL Claude Code sessions.
//
// Fixture provenance (the JSONL files themselves cannot carry headers):
// - fixtures/turns/main-claude — session d961755c… of the yet-another-awesome-game
//   project (the reference session: 15 user turns), trimmed down to 5 tracked
//   files: the snapshot/delta records are genuine, trackedFileBackups is filtered
//   to those files, the file-history backups are copied as is; long prompts are
//   truncated to 600 characters.
// - fixtures/turns/replay-claude — session da5d7c07… of the same project: the
//   snapshots are genuine, the file-history directory does NOT exist — the
//   recovery path via toolUseResult (replay).
// - fixtures/turns/broken-claude — a hand-made "broken schema":
//   trackedFileBackups is suddenly an array.
//
// The cwd in the options points to a nonexistent directory, so the "disk" for
// the last turn is always empty — the tests do not depend on the live machine.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { turnsDiffSource } from "../src/diff/index.ts";
import type { DiffSourceOptions } from "../src/diff/index.ts";
import { promptSnippet } from "../src/diff/jsonl.ts";
import { splitLines } from "../src/diff/text-diff.ts";
import { buildTurnChangesets } from "../src/diff/turns.ts";
import type { Changeset, DiffSource, FileDiff } from "../src/model/diff.ts";
import { applyHunks, captureStderr } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "turns");
const SLUG = "-Users-alaev89-Desktop-pet-projects-yet-another-awesome-game";
const MAIN_SID = "d961755c-b183-4b29-b17d-ef95589d3e72";
const REPLAY_SID = "da5d7c07-3fe6-4881-810e-d7b52f7b32c6";
const BROKEN_SID = "bad00000-0000-4000-8000-000000000bad";

function fixtureOptions(dir: string, sid: string, slug: string): DiffSourceOptions {
	const claudeDir = join(FIXTURES, dir);
	const cwd = join(claudeDir, "no-such-root");
	return {
		cwd,
		claudeDir,
		session: {
			sessionId: sid,
			cwd,
			transcriptPath: join(claudeDir, "projects", slug, `${sid}.jsonl`),
			claudePid: null,
			origin: "env",
		},
	};
}

function fileOf(changeset: Changeset, path: string): FileDiff {
	const file = changeset.files.find((candidate) => candidate.path === path);
	assert.ok(file !== undefined, `${changeset.id} has no file ${path}`);
	return file;
}

describe("turns: the reference session (file-history)", () => {
	const changesets = buildTurnChangesets(fixtureOptions("main-claude", MAIN_SID, SLUG));
	const byId = new Map(changesets.map((changeset) => [changeset.id, changeset]));

	it("turn list: only turns that changed files, freshest first", () => {
		assert.deepEqual(
			changesets.map((changeset) => changeset.id),
			["T14", "T13", "T12", "T11", "T10", "T9", "T6", "T4", "T2"],
		);
	});

	it("service and empty turns do not end up in the switcher", () => {
		// T1 — /clear, T7 — no snapshot, T3/T5/T8 — snapshots exist, no changes,
		// T15 — the last turn, disk outside the root is not read.
		for (const id of ["T1", "T3", "T5", "T7", "T8", "T15"]) {
			assert.ok(!byId.has(id), `${id} must not end up in the switcher`);
		}
	});

	it("labels: turn number + prompt snippet (mandatory per the spec)", () => {
		for (const changeset of changesets) {
			assert.equal(changeset.mode, "turn");
			assert.ok(typeof changeset.turn === "number");
			assert.equal(changeset.id, `T${changeset.turn}`);
			assert.ok(typeof changeset.promptSnippet === "string" && changeset.promptSnippet.length > 0);
			assert.ok(changeset.label.includes(changeset.id) && changeset.label.includes(changeset.promptSnippet));
		}
		assert.match((byId.get("T2") as Changeset).label, /Пошаговый grid-roguelike/);
		assert.match((byId.get("T9") as Changeset).label, /по этим вопросам понятно/);
		// bash input is collapsed into "! command"
		assert.match((byId.get("T6") as Changeset).promptSnippet as string, /^! git/);
	});

	it("cumulativeness of trackedFileBackups is handled: comparison by backupFileName, not by size", () => {
		// In the full session the set grew by just 1 entry between snapshots T9 and
		// T10 (38 → 39), but by backupFileName turn T9 changed SEVERAL files — here
		// all three of the trimmed set. Counting "by set size" would give 1.
		assert.deepEqual(
			(byId.get("T9") as Changeset).files.map((file) => file.path),
			["readme.md", "src/game/build.ts", "src/game/events.ts"],
		);
		// And in turns T12/T11 the old and new versions of readme.md have the same
		// LENGTH — they can only be told apart by version content, not by metadata.
		for (const id of ["T11", "T12"]) {
			const file = fileOf(byId.get(id) as Changeset, "readme.md");
			assert.equal(file.oldText?.length, file.newText?.length);
			assert.notEqual(file.oldText, file.newText);
			assert.ok(file.hunks.length > 0);
		}
	});

	it("every turn's diff is correct: the hunks reconstruct the new version from the old", () => {
		for (const changeset of changesets) {
			for (const file of changeset.files) {
				assert.equal(file.binary, false);
				const oldText = file.oldText ?? "";
				const newText = file.newText ?? "";
				assert.notEqual(oldText, newText);
				assert.equal(
					applyHunks(oldText, file.hunks),
					splitLines(newText).join("\n"),
					`${changeset.id}: ${file.path}`,
				);
			}
		}
	});

	it("the diff sides are the real versions from file-history", () => {
		const historyDir = join(FIXTURES, "main-claude", "file-history", MAIN_SID);
		const t2 = fileOf(byId.get("T2") as Changeset, "src/game/build.ts");
		assert.equal(t2.changeKind, "added"); // Write created the file: backupFileName is null in the delta
		assert.equal(t2.oldText, undefined);
		assert.equal(t2.newText, readFileSync(join(historyDir, "35ba35c0900f4677@v2"), "utf8"));

		// readme.md existed before the session: the "before" state is the @v1 backup from the turn's delta
		const readme = fileOf(byId.get("T2") as Changeset, "readme.md");
		assert.equal(readme.changeKind, "modified");
		assert.equal(readme.oldText, readFileSync(join(historyDir, "35a9ef793739397b@v1"), "utf8"));
	});

	it("files outside the changeset root are addressed by an absolute path", () => {
		const t4 = byId.get("T4") as Changeset;
		assert.equal(t4.files.length, 1);
		const memory = t4.files[0] as FileDiff;
		assert.ok(memory.path.startsWith("/"), "the path must stay absolute");
		assert.match(memory.path, /memory\/mage-ui-tickets-need-a-live-stand\.md$/);
		assert.equal(memory.changeKind, "added");
	});
});

describe("turns: fallback replay via toolUseResult", () => {
	it("without the file-history directory the turns are reconstructed from Edit/Write", async () => {
		let changesets: Changeset[] = [];
		const stderr = await captureStderr(() => {
			changesets = buildTurnChangesets(fixtureOptions("replay-claude", REPLAY_SID, SLUG));
		});
		assert.match(stderr, /replay/);

		assert.deepEqual(changesets.map((changeset) => changeset.id), ["T19", "T17"]);
		const design = fileOf(changesets[1] as Changeset, "DESIGN.md");
		assert.equal(design.changeKind, "added");
		assert.equal(design.newText?.length, 9586); // content from the create toolUseResult
		const tickets = fileOf(changesets[0] as Changeset, "tickets.md");
		assert.equal(tickets.changeKind, "added");
		assert.equal(tickets.newText?.length, 16957);
		for (const changeset of changesets) {
			for (const file of changeset.files) {
				assert.equal(applyHunks(file.oldText ?? "", file.hunks), splitLines(file.newText ?? "").join("\n"));
			}
		}
	});
});

describe("turns: graceful degradation", () => {
	const marker: Changeset = {
		id: "current",
		mode: "current",
		label: "Current state",
		root: "/tmp",
		files: [],
	};
	const fallback: DiffSource = {
		name: "current",
		changesets: () => Promise.resolve([marker]),
	};

	it("unfamiliar snapshot schema → current with a warning, without crashing", async () => {
		const source = turnsDiffSource(fixtureOptions("broken-claude", BROKEN_SID, "-tmp-broken-project"), fallback);
		let result: Changeset[] = [];
		const stderr = await captureStderr(async () => {
			result = await source.changesets();
		});
		assert.deepEqual(result, [marker]);
		assert.match(stderr, /per-turn diff unavailable/);
		assert.match(stderr, /degrading to current/);
	});

	it("no transcript → current as well, with a clear reason", async () => {
		const options = fixtureOptions("main-claude", MAIN_SID, SLUG);
		options.session = { ...options.session, transcriptPath: null };
		const source = turnsDiffSource(options, fallback);
		let result: Changeset[] = [];
		const stderr = await captureStderr(async () => {
			result = await source.changesets();
		});
		assert.deepEqual(result, [marker]);
		assert.match(stderr, /session transcript not found/);
	});
});

describe("turns: prompt snippets", () => {
	it("service wrappers are collapsed", () => {
		assert.equal(
			promptSnippet("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
			"/clear",
		);
		assert.equal(promptSnippet("<bash-input>git status</bash-input>"), "! git status");
		assert.equal(promptSnippet("<command-message>go</command-message>ignored"), "go");
	});
	it("a long prompt is truncated with an ellipsis", () => {
		const snippet = promptSnippet("a".repeat(200));
		assert.equal(snippet.length, 60);
		assert.ok(snippet.endsWith("…"));
	});
	it("newlines are collapsed into spaces", () => {
		assert.equal(promptSnippet("one\ntwo\n\nthree"), "one two three");
	});
});
