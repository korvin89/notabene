// Contract test "CLI ↔ hunk extension": the handoff written by
// src/hunk/handoff.ts is read by the extension; the mirror written by the
// extension is read by src/hunk/notes.ts. The extension is self-contained
// (schemas duplicated structurally) — this very test guards their sync.
//
// hunk itself is not started here (T5 rule: do not touch the TUI) — the
// extension is invoked directly with a fake HunkExtensionAPI, events are emulated.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { HunkExtensionAPI } from "hunkdiff/extension";
import claudeDiffExtension from "../src/hunk-ext/index.ts";
import { HANDOFF_ENV, handoffPath, mirrorPath, notesPath, readHandoff, reviewCancelled, writeHandoff } from "../src/hunk/handoff.ts";
import { notesToComments, readMirrorNotes } from "../src/hunk/notes.ts";
import type { Changeset } from "../src/model/diff.ts";

type Handler = (payload: unknown, ctx: unknown) => void | Promise<void>;

interface FakeHunk {
	api: HunkExtensionAPI;
	adapter: {
		detect(cwd: string): { id: string; repoRoot: string } | null;
		detectionPriority?: number;
		operations?: Record<string, { load(input: unknown, ctx: unknown): Promise<Record<string, unknown>> }>;
	} | null;
	commands: Map<string, { key?: string | readonly string[]; handler: (ctx: unknown) => void | Promise<void> }>;
	handlers: Map<string, Handler[]>;
	logs: string[];
	emit(event: string, payload: unknown): Promise<void>;
}

function fakeHunk(): FakeHunk {
	const fake: FakeHunk = {
		api: null as unknown as HunkExtensionAPI,
		adapter: null,
		commands: new Map(),
		handlers: new Map(),
		logs: [],
		async emit(event, payload): Promise<void> {
			for (const handler of fake.handlers.get(event) ?? []) await handler(payload, {});
		},
	};
	fake.api = {
		apiVersion: 25,
		registerVcsAdapter(adapter: never): void {
			fake.adapter = adapter;
		},
		registerCommand(command: { id: string; key?: string | readonly string[] }, handler: never): void {
			fake.commands.set(command.id, { ...(command.key !== undefined ? { key: command.key } : {}), handler });
		},
		on(event: string, handler: never): void {
			const list = fake.handlers.get(event) ?? [];
			list.push(handler);
			fake.handlers.set(event, list);
		},
		log(message: string): void {
			fake.logs.push(message);
		},
	} as unknown as HunkExtensionAPI;
	return fake;
}

function fixtureChangesets(root: string): Changeset[] {
	return [
		{
			id: "current",
			mode: "current",
			label: "Current state",
			root,
			files: [
				{
					path: "a.txt",
					changeKind: "modified",
					binary: false,
					hunks: [
						{
							oldStart: 1,
							oldLines: 1,
							newStart: 1,
							newLines: 1,
							lines: [
								{ kind: "del", oldLine: 1, newLine: null, text: "old line" },
								{ kind: "add", oldLine: null, newLine: 1, text: "new line" },
							],
						},
					],
					oldText: "old line\n",
					newText: "new line\n",
				},
			],
		},
		{
			id: "T2",
			mode: "turn",
			label: "Turn T2 (\"fix the balance\")",
			turn: 2,
			promptSnippet: "fix the balance",
			root,
			files: [
				{
					path: "src/weapons.ts",
					changeKind: "modified",
					binary: false,
					hunks: [],
					oldText: "const KB = 1;\n",
					newText: "const KB = 4;\nconst CRIT = 2;\nconst X = 3;\nconst Y = 4;\n",
				},
			],
		},
	];
}

describe("hunk extension against the handoff contract", () => {
	let cwd: string;
	let hunkStub: string;
	let stubLog: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "notabene-ext-"));
		stubLog = join(cwd, "hunk-stub.log");
		hunkStub = join(cwd, "hunk-stub.sh");
		// `session list` responds with a session carrying THIS process's pid:
		// exactly how the extension finds its own session from the hunk process
		// (see src/hunk-ext).
		writeFileSync(
			hunkStub,
			`#!/bin/sh\necho "$@" >> "${stubLog}"\n`
				+ `if [ "$1 $2" = "session list" ]; then\n`
				+ `  echo '{"sessions":[{"sessionId":"sid-test","pid":${process.pid},"cwd":"${cwd}"}]}'\n`
				+ `fi\n`,
		);
		chmodSync(hunkStub, 0o755);
		process.env[HANDOFF_ENV] = writeHandoff(cwd, {
			changesets: fixtureChangesets(cwd),
			activeId: "T2",
			hunkBin: hunkStub,
			stamp: "2026-09-14T12:00:00+03:00",
		});
	});

	afterEach(() => {
		delete process.env[HANDOFF_ENV];
		rmSync(cwd, { recursive: true, force: true });
	});

	test("without NOTABENE_HANDOFF the extension stays silent and registers nothing", () => {
		delete process.env[HANDOFF_ENV];
		const fake = fakeHunk();
		claudeDiffExtension(fake.api);
		assert.equal(fake.adapter, null);
		assert.equal(fake.commands.size, 0);
	});

	test("handoff with an unknown schema — the extension turns itself off with a log entry", () => {
		writeFileSync(handoffPath(cwd), JSON.stringify({ version: 99 }));
		const fake = fakeHunk();
		claudeDiffExtension(fake.api);
		assert.equal(fake.adapter, null);
		assert.match(fake.logs.join("\n"), /unknown schema/);
	});

	test("adapter: detect returns the root, load — the active turn and switching by range", async () => {
		const fake = fakeHunk();
		claudeDiffExtension(fake.api);
		assert.ok(fake.adapter !== null);
		assert.deepEqual(fake.adapter.detect(cwd), { id: "notabene", repoRoot: cwd });
		assert.ok((fake.adapter.detectionPriority ?? 0) > 0, "priority must beat git");

		const load = fake.adapter.operations?.["working-tree-diff"]?.load;
		assert.ok(load !== undefined);

		// without range — activeId from the handoff. The title carries the key
		// hint: hunk paints it in the menu bar, the one place always on screen.
		const active = await load({ kind: "vcs", staged: false, options: {} }, {});
		assert.equal(active["title"], "Turn T2 (\"fix the balance\")  [C] complete  [x] cancel");
		assert.equal(active["sourceLabel"], "notabene: T2");

		// an explicit range switches
		const current = await load({ kind: "vcs", range: "current", staged: false, options: {} }, {});
		assert.equal(current["title"], "Current state  [C] complete  [x] cancel");
		assert.match(String(current["patchText"]), /^diff --git a\/a\.txt b\/a\.txt\n/);

		// readFileSource: both sides and a missing file
		const read = current["readFileSource"] as (request: Record<string, unknown>) => Promise<string | null>;
		assert.equal(await read({ path: "a.txt", side: "old" }), "old line\n");
		assert.equal(await read({ path: "a.txt", side: "new" }), "new line\n");
		assert.equal(await read({ path: "missing.txt", side: "new" }), null);

		// an unknown turn — a "for the user" error, structurally
		await assert.rejects(
			async () => load({ kind: "vcs", range: "T99", staged: false, options: {} }, {}),
			(error: Error) => error.name === "HunkExtensionUserError" && /T99/.test(error.message),
		);
	});

	test("the mirror lives under the name from the handoff, not the legacy notes.json", () => {
		const fake = fakeHunk();
		claudeDiffExtension(fake.api);

		// the name is unique per review: a forgotten past viewer writes to its own file
		const mirror = mirrorPath(cwd);
		assert.equal(mirror, readHandoff(cwd)?.notesPath);
		assert.match(mirror, /notes-2026-09-14T12-00-00\.json$/);
		assert.notEqual(mirror, notesPath(cwd));
		assert.deepEqual(readMirrorNotes(mirror), []);
	});

	test("mirror: marker on load, note events, deletion, reading via the bridge", async () => {
		const fake = fakeHunk();
		claudeDiffExtension(fake.api);
		const mirror = mirrorPath(cwd);

		// the "extension loaded" marker — an empty list
		assert.deepEqual(readMirrorNotes(mirror), []);

		// a draft is not written
		await fake.emit("note_created", {
			note: { id: "user:1-1", filePath: "src/weapons.ts", side: "new", newRange: [2, 2], body: "draft", draft: true },
		});
		assert.equal(readMirrorNotes(mirror)?.length, 0);

		// a saved note is written, an edit updates the body
		await fake.emit("note_created", {
			note: { id: "user:1-1", filePath: "src/weapons.ts", side: "new", newRange: [2, 2], body: "[q] why the crit?", draft: false },
		});
		await fake.emit("note_created", {
			note: { id: "user:1-2", filePath: "a.txt", side: "old", oldRange: [1, 1], body: "put it back", draft: false },
		});
		await fake.emit("note_edited", {
			note: { id: "user:1-2", filePath: "a.txt", side: "old", oldRange: [1, 1], body: "[b] put it back", draft: false },
		});
		// a comment on a CHANGED line: hunk fills in BOTH ranges, and only the
		// side field says the anchor is on the old side. If the mirror stops
		// writing it, the bridge heuristic silently makes the comment new-sided.
		await fake.emit("note_created", {
			note: {
				id: "user:1-4",
				filePath: "a.txt",
				side: "old",
				oldRange: [1, 1],
				newRange: [1, 1],
				body: "why was this line changed?",
				draft: false,
			},
		});
		// someone else's note via note_changed (e.g. an agent's) — stored with its source
		await fake.emit("note_changed", {
			kind: "created",
			note: { id: "agent:1", source: "agent", fileKey: "file:xyz", summary: "agent note", anchor: { newRange: [1, 1] } },
		});
		// note deletion
		await fake.emit("note_created", {
			note: { id: "user:1-3", filePath: "a.txt", side: "new", newRange: [1, 1], body: "redundant", draft: false },
		});
		await fake.emit("note_changed", {
			kind: "removed",
			note: { id: "user:1-3", source: "user", fileKey: "file:abc", summary: "redundant", anchor: {} },
		});
		await fake.emit("shutdown", {});

		const notes = readMirrorNotes(mirror);
		assert.ok(notes !== null);
		assert.deepEqual(
			notes.map((note) => note.id),
			["user:1-1", "user:1-2", "user:1-4", "agent:1"],
		);

		// bridge: the agent note is filtered out, types recognized, context from the handoff
		const comments = notesToComments(notes, readHandoff(cwd));
		assert.equal(comments.length, 3);
		const [first, second, both] = comments;

		// both ranges present — only the side field decides the side
		assert.equal(both?.side, "old");
		assert.equal(both?.startLine, 1);
		assert.deepEqual(both?.context, ["old line", ""]);
		assert.equal(first?.file, "src/weapons.ts");
		assert.equal(first?.type, "question");
		assert.equal(first?.body, "why the crit?");
		assert.equal(first?.side, "new");
		assert.equal(first?.startLine, 2);
		assert.equal(first?.endLine, 2);
		assert.deepEqual(first?.context, ["const CRIT = 2;", "const X = 3;", "const Y = 4;"]);
		assert.equal(second?.type, "blocker");
		assert.equal(second?.side, "old");
		assert.deepEqual(second?.context, ["old line", ""]);
	});

	test("reopening the viewer continues the mirror instead of resetting it", async () => {
		const first = fakeHunk();
		claudeDiffExtension(first.api);
		await first.emit("note_created", {
			note: { id: "user:1-1", filePath: "a.txt", side: "new", newRange: [1, 1], body: "important", draft: false },
		});
		await first.emit("shutdown", {});

		// a second `ntb open` on the same prepared review: hunk starts
		// afresh, its ReviewStore is empty, but the previous session's comment must not be lost
		const second = fakeHunk();
		claudeDiffExtension(second.api);
		assert.deepEqual(readMirrorNotes(mirrorPath(cwd))?.map((note) => note.body), ["important"]);

		await second.emit("note_created", {
			note: { id: "user:2-1", filePath: "a.txt", side: "new", newRange: [1, 1], body: "addition", draft: false },
		});
		assert.deepEqual(
			notesToComments(readMirrorNotes(mirrorPath(cwd)) ?? [], readHandoff(cwd)).map((note) => note.body),
			["important", "addition"],
		);
	});

	test("turn switching: <(newer) and >(older) shell out to session reload, edges do not", async () => {
		const fake = fakeHunk();
		claudeDiffExtension(fake.api);
		const notices: string[] = [];
		const ctx = { notify: (message: string) => notices.push(message), dialogs: {} };

		// activeId = T2 (index 1 of [current, T2]); "<" leads to current.
		// The session is found by pid via `session list` (--repo does not work with a VCS adapter).
		await fake.commands.get("prevTurn")?.handler(ctx);
		assert.match(readFileSync(stubLog, "utf8"), /session list --json/);
		assert.match(readFileSync(stubLog, "utf8"), /session reload sid-test --json -- diff current/);

		// ">" from T2 — the edge of the list: reload is not called, there is a hint
		rmSync(stubLog, { force: true });
		await fake.commands.get("nextTurn")?.handler(ctx);
		assert.equal(existsSync(stubLog), false);
		assert.match(notices.join("\n"), /oldest/);

		// picking from the list by label
		const pickCtx = {
			notify: (message: string) => notices.push(message),
			dialogs: { select: async () => "Current state" },
		};
		await fake.commands.get("pickTurn")?.handler(pickCtx);
		assert.match(readFileSync(stubLog, "utf8"), /-- diff current/);

		// the keys do not clash with hunk's built-ins (`,`/`.` are taken by files)
		assert.equal(fake.commands.get("prevTurn")?.key, "<");
		assert.equal(fake.commands.get("nextTurn")?.key, ">");
		assert.equal(fake.commands.get("pickTurn")?.key, "T");
	});

	test("finishing: C completes, x cancels after a confirmation, a stale marker does not carry over", async () => {
		const fake = fakeHunk();
		claudeDiffExtension(fake.api);

		// Free of hunk's built-ins: `q` is app.quit and `c` starts a note, so a
		// chord of theirs would be dropped from our command with a warning.
		assert.equal(fake.commands.get("completeReview")?.key, "C");
		assert.deepEqual(fake.commands.get("cancelReview")?.key, ["x", "X"]);

		const executed: string[] = [];
		let confirmations = 0;
		const ctx = (answer: boolean): unknown => ({
			notify: (): void => {},
			commands: {
				execute: (id: string): boolean => {
					executed.push(id);
					return true;
				},
			},
			dialogs: {
				confirm: async (): Promise<boolean> => {
					confirmations += 1;
					return answer;
				},
			},
		});

		// complete: quits and writes no marker — delivery is the default outcome
		await fake.commands.get("completeReview")?.handler(ctx(true));
		assert.deepEqual(executed, ["hunk.app.quit"]);
		assert.equal(reviewCancelled(cwd), false);

		// an empty review is cancelled without asking
		await fake.commands.get("cancelReview")?.handler(ctx(true));
		assert.equal(confirmations, 0, "nothing to discard — no dialog");
		assert.equal(reviewCancelled(cwd), true);

		// with comments the dialog decides: declining leaves the review alone
		const reopened = fakeHunk();
		claudeDiffExtension(reopened.api);
		assert.equal(reviewCancelled(cwd), false, "a marker of a previous opening must not decide this review");
		await reopened.emit("note_created", {
			note: { id: "user:1-1", filePath: "a.txt", side: "new", newRange: [1, 1], body: "keep me", draft: false },
		});
		executed.length = 0;
		await reopened.commands.get("cancelReview")?.handler(ctx(false));
		assert.equal(confirmations, 1);
		assert.deepEqual(executed, [], "a declined cancel must not close the viewer");
		assert.equal(reviewCancelled(cwd), false);

		// confirming it records the cancellation and quits
		await reopened.commands.get("cancelReview")?.handler(ctx(true));
		assert.equal(confirmations, 2);
		assert.deepEqual(executed, ["hunk.app.quit"]);
		assert.equal(reviewCancelled(cwd), true);
	});
});
