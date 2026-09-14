// T6: review storage — the flow C pending cycle and the machine-readable copy (§3.2)
// in `<repo>/.claude/reviews/`. Everything runs on temporary directories.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ReviewError } from "../src/io.ts";
import { fileCommentStore, pendingPath, reviewsDir } from "../src/store/index.ts";
import { reviewTurnFixture } from "./fixtures/review-turn.ts";

function tempRepo(): string {
	return mkdtempSync(join(tmpdir(), "notabene-store-"));
}

describe("pending document (flow C)", () => {
	test("loadPending with no file → null", async () => {
		const store = fileCommentStore(tempRepo());
		assert.equal(await store.loadPending(), null);
	});

	test("savePending → loadPending returns the same document", async () => {
		const cwd = tempRepo();
		const store = fileCommentStore(cwd);
		const doc = reviewTurnFixture();

		await store.savePending(doc);
		assert.deepEqual(await store.loadPending(), doc);
		assert.equal(store.dir, reviewsDir(cwd));
	});

	test("clearPending removes the file and does not fail when it is missing", async () => {
		const cwd = tempRepo();
		const store = fileCommentStore(cwd);

		await store.clearPending(); // the file does not exist yet — not an error
		await store.savePending(reviewTurnFixture());
		await store.clearPending();
		assert.equal(existsSync(pendingPath(cwd)), false);
		assert.equal(await store.loadPending(), null);
	});

	test("corrupted pending → a clear error, not a parser crash", async () => {
		const cwd = tempRepo();
		mkdirSync(reviewsDir(cwd), { recursive: true });
		writeFileSync(pendingPath(cwd), "this is not JSON{{{");

		await assert.rejects(fileCommentStore(cwd).loadPending(), (error: unknown) => {
			assert.ok(error instanceof ReviewError);
			assert.match(error.message, /pending document is corrupted/);
			return true;
		});
	});

	test("valid JSON that is not a review document → a clear error", async () => {
		const cwd = tempRepo();
		mkdirSync(reviewsDir(cwd), { recursive: true });
		writeFileSync(pendingPath(cwd), JSON.stringify({ version: 99 }));

		await assert.rejects(fileCommentStore(cwd).loadPending(), (error: unknown) => {
			assert.ok(error instanceof ReviewError);
			assert.match(error.message, /does not look like a review/);
			return true;
		});
	});
});

describe("machine-readable copy (§3.2)", () => {
	test("saveFinal writes valid JSON and returns a path relative to the repo", async () => {
		const cwd = tempRepo();
		const doc = reviewTurnFixture();

		const relPath = await fileCommentStore(cwd).saveFinal(doc);
		// The file name is the timestamp from createdAt, as in the §3.1 example.
		assert.equal(relPath, join(".claude", "reviews", "2026-09-13T20-15-31.json"));

		const onDisk = JSON.parse(await readFile(join(cwd, relPath), "utf8")) as unknown;
		assert.deepEqual(onDisk, doc);
	});

	test("two reviews within one second do not overwrite each other", async () => {
		const cwd = tempRepo();
		const store = fileCommentStore(cwd);
		const first = reviewTurnFixture();
		const second = { ...reviewTurnFixture(), comments: [] };

		const firstPath = await store.saveFinal(first);
		const secondPath = await store.saveFinal(second);

		assert.notEqual(firstPath, secondPath);
		assert.match(secondPath, /2026-09-13T20-15-31-2\.json$/);
		assert.deepEqual(JSON.parse(await readFile(join(cwd, firstPath), "utf8")), first);
		assert.deepEqual(JSON.parse(await readFile(join(cwd, secondPath), "utf8")), second);
	});
});
