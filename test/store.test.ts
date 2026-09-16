// T6: review storage — the flow C pending cycle and the machine-readable copy
// (§3.2), plus the out-of-tree state directory and the migration into it (D30).
// Everything runs on temporary directories.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, test } from "node:test";
import { ReviewError } from "../src/io.ts";
import { fileCommentStore, pendingPath, reviewStateDir } from "../src/store/index.ts";
import { legacyStateDir, migrateLegacyState } from "../src/store/migrate.ts";
import { captureStderr } from "./helpers.ts";
import { reviewTurnFixture } from "./fixtures/review-turn.ts";

function tempDir(prefix = "notabene-store-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("the state directory lives outside the reviewed repository (D30)", () => {
	test("it is under claudeDir, keyed by the review root", () => {
		const dir = reviewStateDir("/Users/x/pet-projects/notabene", "/Users/x/.claude");
		assert.equal(dir, "/Users/x/.claude/notabene/-Users-x-pet-projects-notabene");
	});

	test("nothing of ours resolves inside the repository", () => {
		const root = "/Users/x/pet-projects/notabene";
		const rel = relative(root, reviewStateDir(root, "/Users/x/.claude"));
		assert.ok(rel.startsWith("..") || isAbsolute(rel), `state dir must not be under the root: ${rel}`);
	});

	test("two repositories with the same basename do not share a directory", () => {
		const claude = "/Users/x/.claude";
		assert.notEqual(reviewStateDir("/a/notabene", claude), reviewStateDir("/b/notabene", claude));
	});
});

describe("pending document (flow C)", () => {
	test("loadPending with no file → null", async () => {
		const store = fileCommentStore(tempDir());
		assert.equal(await store.loadPending(), null);
	});

	test("savePending → loadPending returns the same document", async () => {
		const dir = tempDir();
		const store = fileCommentStore(dir);
		const doc = reviewTurnFixture();

		await store.savePending(doc);
		assert.deepEqual(await store.loadPending(), doc);
		assert.equal(store.dir, dir);
	});

	test("clearPending removes the file and does not fail when it is missing", async () => {
		const dir = tempDir();
		const store = fileCommentStore(dir);

		await store.clearPending(); // the file does not exist yet — not an error
		await store.savePending(reviewTurnFixture());
		await store.clearPending();
		assert.equal(existsSync(pendingPath(dir)), false);
		assert.equal(await store.loadPending(), null);
	});

	test("corrupted pending → a clear error, not a parser crash", async () => {
		const dir = tempDir();
		writeFileSync(pendingPath(dir), "this is not JSON{{{");

		await assert.rejects(fileCommentStore(dir).loadPending(), (error: unknown) => {
			assert.ok(error instanceof ReviewError);
			assert.match(error.message, /pending document is corrupted/);
			return true;
		});
	});

	test("valid JSON that is not a review document → a clear error", async () => {
		const dir = tempDir();
		writeFileSync(pendingPath(dir), JSON.stringify({ version: 99 }));

		await assert.rejects(fileCommentStore(dir).loadPending(), (error: unknown) => {
			assert.ok(error instanceof ReviewError);
			assert.match(error.message, /does not look like a review/);
			return true;
		});
	});
});

describe("machine-readable copy (§3.2)", () => {
	test("saveFinal writes valid JSON and returns an absolute path", async () => {
		const dir = tempDir();
		const doc = reviewTurnFixture();

		// Absolute since D30: relative to what used to be the repository root, the
		// path stopped resolving once the copies left the tree.
		const path = await fileCommentStore(dir).saveFinal(doc);
		assert.ok(isAbsolute(path), `must be absolute: ${path}`);
		// The file name is the timestamp from createdAt, as in the §3.1 example.
		assert.equal(path, join(dir, "2026-09-13T20-15-31.json"));

		assert.deepEqual(JSON.parse(await readFile(path, "utf8")) as unknown, doc);
	});

	test("two reviews within one second do not overwrite each other", async () => {
		const dir = tempDir();
		const store = fileCommentStore(dir);
		const first = reviewTurnFixture();
		const second = { ...reviewTurnFixture(), comments: [] };

		const firstPath = await store.saveFinal(first);
		const secondPath = await store.saveFinal(second);

		assert.notEqual(firstPath, secondPath);
		assert.match(secondPath, /2026-09-13T20-15-31-2\.json$/);
		assert.deepEqual(JSON.parse(await readFile(firstPath, "utf8")), first);
		assert.deepEqual(JSON.parse(await readFile(secondPath, "utf8")), second);
	});
});

describe("migration out of the pre-D30 in-tree directory", () => {
	function legacyRepo(files: Record<string, string>): string {
		const root = tempDir("notabene-legacy-");
		mkdirSync(legacyStateDir(root), { recursive: true });
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(legacyStateDir(root), name), body);
		}
		return root;
	}

	test("an in-flight review and the history move over, the directory goes away", async () => {
		const root = legacyRepo({
			"pending.json": '{"version":1}',
			"handoff.json": '{"version":1}',
			"notes-2026-09-14T12-00-00.json": "[]",
			"notes-2026-09-14T12-00-00.outcome.json": '{"version":1,"outcome":"cancelled"}',
			"2026-09-13T20-15-31.json": '{"version":1}',
		});
		const state = join(tempDir(), "state");

		const stderr = await captureStderr(() => {
			assert.equal(migrateLegacyState(root, state), 5);
		});

		assert.deepEqual(readdirSync(state).sort(), [
			"2026-09-13T20-15-31.json",
			"handoff.json",
			"notes-2026-09-14T12-00-00.json",
			"notes-2026-09-14T12-00-00.outcome.json",
			"pending.json",
		]);
		// Left behind it would sit in the user's `git status` forever — D30 no
		// longer asks anyone for a `.gitignore` line.
		assert.equal(existsSync(legacyStateDir(root)), false);
		assert.match(stderr, /no longer live in the repository/);
	});

	test("the handoff is repointed at the moved mirror, not left dangling", () => {
		// A pre-D30 handoff names its mirror by absolute path into the directory we
		// just emptied. Unfixed, `collect` finds nothing and delivers an empty
		// review — losing exactly the comments this migration is here to save.
		const root = tempDir("notabene-legacy-");
		const legacy = legacyStateDir(root);
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "notes-2026-09-14T12-00-00.json"), '[{"id":"user:1"}]');
		writeFileSync(
			join(legacy, "handoff.json"),
			JSON.stringify({
				version: 1,
				root,
				notesPath: join(legacy, "notes-2026-09-14T12-00-00.json"),
				outcomePath: join(legacy, "notes-2026-09-14T12-00-00.outcome.json"),
				changesets: [],
			}),
		);
		const state = join(tempDir(), "state");

		migrateLegacyState(root, state);

		const handoff = JSON.parse(readFileSync(join(state, "handoff.json"), "utf8")) as {
			root: string;
			notesPath: string;
			outcomePath: string;
		};
		assert.equal(handoff.notesPath, join(state, "notes-2026-09-14T12-00-00.json"));
		assert.equal(handoff.outcomePath, join(state, "notes-2026-09-14T12-00-00.outcome.json"));
		assert.ok(existsSync(handoff.notesPath), "the mirror must be where the handoff now says");
		// the review root is a different thing and must survive untouched
		assert.equal(handoff.root, root);
	});

	test("a `.claude` that holds anything else is kept", () => {
		// Removing the empty `.claude` we created ourselves is tidiness; removing
		// one with the user's Claude Code settings or skills in it would not be.
		const root = legacyRepo({ "pending.json": '{"version":1}' });
		writeFileSync(join(root, ".claude", "settings.json"), "{}\n");

		migrateLegacyState(root, join(tempDir(), "state"));

		assert.equal(existsSync(legacyStateDir(root)), false);
		assert.deepEqual(readdirSync(join(root, ".claude")), ["settings.json"]);
	});

	test("nothing to migrate — a no-op, not an error", () => {
		assert.equal(migrateLegacyState(tempDir("notabene-clean-"), join(tempDir(), "state")), 0);
	});

	test("a foreign file is not touched, and it keeps the directory alive", () => {
		const root = legacyRepo({ "pending.json": '{"version":1}', "NOTES.md": "mine\n" });
		const state = join(tempDir(), "state");

		assert.equal(migrateLegacyState(root, state), 1);
		assert.deepEqual(readdirSync(legacyStateDir(root)), ["NOTES.md"]);
		assert.deepEqual(readdirSync(state), ["pending.json"]);
	});

	test("a file already in the new location is never clobbered", () => {
		const root = legacyRepo({ "pending.json": "old" });
		const state = join(tempDir(), "state");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "pending.json"), "new");

		assert.equal(migrateLegacyState(root, state), 0);
		assert.equal(readFileSync(join(state, "pending.json"), "utf8"), "new");
		assert.equal(readFileSync(join(legacyStateDir(root), "pending.json"), "utf8"), "old");
	});
});
