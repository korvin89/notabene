// Tests of the scope builder (T3, ARCHITECTURE.md §4.2) on fixture git
// repositories: every test does git init/commits in a temp directory itself,
// after() cleans up for everyone. Patch-markup edge cases live next door, in
// diff-parse.test.ts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { after, describe, test } from "node:test";
import { buildScopes } from "../src/diff/scopes.ts";
import type { ScopeOptions, ScopeRequest } from "../src/diff/scopes.ts";
import { reviewStateDir } from "../src/store/index.ts";
import type { Changeset, FileDiff, ScopeId } from "../src/model/diff.ts";

// The builder inherits the process environment — detach it from the user's
// gitconfig so the tests do not depend on anybody's diff.* settings.
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};

interface RepoFixture {
	root: string;
	git(...args: string[]): void;
	write(path: string, content: string | Buffer): void;
	rm(path: string): void;
	options(request?: ScopeRequest): ScopeOptions;
}

const cleanups: string[] = [];
after(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function repo(init = true): RepoFixture {
	// realpath right away: on macOS tmpdir sits behind the /var → /private/var
	// symlink, while `git rev-parse --show-toplevel` returns the resolved path.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "notabene-t3-")));
	cleanups.push(root);
	const fixture: RepoFixture = {
		root,
		git(...args) {
			execFileSync("git", args, { cwd: root, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
		},
		write(path, content) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		},
		rm(path) {
			rmSync(join(root, path));
		},
		options: (request) => ({
			cwd: root,
			claudeDir: join(root, "no-such-.claude"),
			request: request ?? null,
		}),
	};
	if (init) fixture.git("init", "-q", "-b", "main");
	return fixture;
}

function commitAll(fixture: RepoFixture, message = "fixture"): void {
	fixture.git("add", "-A");
	fixture.git("commit", "-q", "-m", message);
}

/** The ids on offer, in display order — what the viewer's scope picker shows. */
async function scopeIds(fixture: RepoFixture, request?: ScopeRequest): Promise<ScopeId[]> {
	const { changesets } = await buildScopes(fixture.options(request));
	return changesets.map((changeset) => changeset.id);
}

/** The working-tree changeset + a check of its shape. */
async function worktreeChangeset(fixture: RepoFixture): Promise<Changeset> {
	const { changesets, activeId } = await buildScopes(fixture.options());
	assert.equal(activeId, "worktree");
	const changeset = changesets.find((candidate) => candidate.id === "worktree") as Changeset;
	assert.ok(changeset, "the working-tree scope is missing");
	assert.equal(changeset.label, "Working tree");
	assert.equal(changeset.root, fixture.root);
	assert.notEqual(changeset.files.length, 0);
	return changeset;
}

function soleFile(changeset: Changeset): FileDiff {
	assert.equal(changeset.files.length, 1);
	return changeset.files[0] as FileDiff;
}

describe("worktree: modified and new files", () => {
	test("modified file: hunk, line numbering, oldText/newText", async () => {
		const fixture = repo();
		fixture.write("src/app.ts", "one\ntwo\nthree\n");
		commitAll(fixture);
		fixture.write("src/app.ts", "one\ntwo!\nthree\nfour\n");

		const file = soleFile(await worktreeChangeset(fixture));
		assert.equal(file.path, "src/app.ts");
		assert.equal(file.changeKind, "modified");
		assert.equal(file.binary, false);
		assert.equal(file.oldText, "one\ntwo\nthree\n");
		assert.equal(file.newText, "one\ntwo!\nthree\nfour\n");
		assert.deepEqual(file.hunks, [
			{
				oldStart: 1,
				oldLines: 3,
				newStart: 1,
				newLines: 4,
				lines: [
					{ kind: "context", oldLine: 1, newLine: 1, text: "one" },
					{ kind: "del", oldLine: 2, newLine: null, text: "two" },
					{ kind: "add", oldLine: null, newLine: 2, text: "two!" },
					{ kind: "context", oldLine: 3, newLine: 3, text: "three" },
					{ kind: "add", oldLine: null, newLine: 4, text: "four" },
				],
			},
		]);
	});

	test("new untracked file: added, hunk -0,0 +1,N", async () => {
		const fixture = repo();
		fixture.write("README", "project\n");
		commitAll(fixture);
		fixture.write("notes.txt", "alpha\nbeta\n");

		// README did not change — only the untracked file ends up in the changeset
		const file = soleFile(await worktreeChangeset(fixture));
		assert.equal(file.path, "notes.txt");
		assert.equal(file?.changeKind, "added");
		assert.equal(file?.binary, false);
		assert.equal(file?.oldText, undefined);
		assert.equal(file?.newText, "alpha\nbeta\n");
		assert.deepEqual(file?.hunks, [
			{
				oldStart: 0,
				oldLines: 0,
				newStart: 1,
				newLines: 2,
				lines: [
					{ kind: "add", oldLine: null, newLine: 1, text: "alpha" },
					{ kind: "add", oldLine: null, newLine: 2, text: "beta" },
				],
			},
		]);
	});

	test("staged file in a repository without commits — added against the empty tree", async () => {
		const fixture = repo();
		fixture.write("first.txt", "line\n");
		fixture.git("add", "-A");

		const file = soleFile(await worktreeChangeset(fixture));
		assert.equal(file.changeKind, "added");
		assert.equal(file.newText, "line\n");
		assert.equal(file.hunks.length, 1);
	});
});

describe("worktree: deletion and rename", () => {
	test("deleted file: oldText present, newText absent", async () => {
		const fixture = repo();
		fixture.write("gone.txt", "bye\n");
		commitAll(fixture);
		fixture.rm("gone.txt");

		const file = soleFile(await worktreeChangeset(fixture));
		assert.equal(file.path, "gone.txt");
		assert.equal(file.changeKind, "deleted");
		assert.equal(file.oldText, "bye\n");
		assert.equal(file.newText, undefined);
		assert.deepEqual(file.hunks, [
			{
				oldStart: 1,
				oldLines: 1,
				newStart: 0,
				newLines: 0,
				lines: [{ kind: "del", oldLine: 1, newLine: null, text: "bye" }],
			},
		]);
	});

	test("rename without edits: renamed, previousPath, no hunks", async () => {
		const fixture = repo();
		fixture.write("old-name.txt", "raz\ndva\ntri\n");
		commitAll(fixture);
		fixture.git("mv", "old-name.txt", "new-name.txt");

		const file = soleFile(await worktreeChangeset(fixture));
		assert.equal(file.path, "new-name.txt");
		assert.equal(file.changeKind, "renamed");
		assert.equal(file.previousPath, "old-name.txt");
		assert.deepEqual(file.hunks, []);
		assert.equal(file.oldText, "raz\ndva\ntri\n");
		assert.equal(file.newText, "raz\ndva\ntri\n");
	});

	test("rename with an edit: renamed and a hunk with the change", async () => {
		const fixture = repo();
		fixture.write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
		commitAll(fixture);
		fixture.git("mv", "a.txt", "b.txt");
		fixture.write("b.txt", "1\n2\n3\n4\n5\n6\n7\neight\n");

		const file = soleFile(await worktreeChangeset(fixture));
		assert.equal(file.path, "b.txt");
		assert.equal(file.changeKind, "renamed");
		assert.equal(file.previousPath, "a.txt");
		assert.equal(file.hunks.length, 1);
		assert.equal(file.oldText, "1\n2\n3\n4\n5\n6\n7\n8\n");
		assert.equal(file.newText, "1\n2\n3\n4\n5\n6\n7\neight\n");
		const lines = file.hunks[0]?.lines ?? [];
		assert.deepEqual(lines.at(-2), { kind: "del", oldLine: 8, newLine: null, text: "8" });
		assert.deepEqual(lines.at(-1), { kind: "add", oldLine: null, newLine: 8, text: "eight" });
	});
});

describe("worktree: binary and empty files", () => {
	test("binaries: modified (even with a space in the name) and untracked", async () => {
		const fixture = repo();
		fixture.write("bin/im age.bin", Buffer.from([0x00, 0x01, 0x02, 0xff]));
		commitAll(fixture);
		fixture.write("bin/im age.bin", Buffer.from([0x00, 0xaa, 0xbb]));
		fixture.write("raw.bin", Buffer.from([0x7f, 0x00, 0x45, 0x4c, 0x46]));

		const changeset = await worktreeChangeset(fixture);
		assert.deepEqual(
			changeset.files.map((file) => [file.path, file.changeKind, file.binary]),
			[
				["bin/im age.bin", "modified", true],
				["raw.bin", "added", true],
			],
		);
		for (const file of changeset.files) {
			assert.deepEqual(file.hunks, []);
			assert.equal(file.oldText, undefined);
			assert.equal(file.newText, undefined);
		}
	});

	test("empty untracked file: added without hunks, newText is an empty string", async () => {
		const fixture = repo();
		fixture.write("base.txt", "x\n");
		commitAll(fixture);
		fixture.write("empty.txt", "");

		const changeset = await worktreeChangeset(fixture);
		const file = changeset.files.find((entry) => entry.path === "empty.txt");
		assert.equal(file?.changeKind, "added");
		assert.equal(file?.binary, false);
		assert.deepEqual(file?.hunks, []);
		assert.equal(file?.newText, "");
	});

	test("file emptied out: modified, newText is an empty string", async () => {
		const fixture = repo();
		fixture.write("wipe.txt", "content\n");
		commitAll(fixture);
		fixture.write("wipe.txt", "");

		const file = soleFile(await worktreeChangeset(fixture));
		assert.equal(file.changeKind, "modified");
		assert.equal(file.oldText, "content\n");
		assert.equal(file.newText, "");
		assert.deepEqual(file.hunks[0]?.lines, [{ kind: "del", oldLine: 1, newLine: null, text: "content" }]);
	});
});

describe("which scopes a run offers", () => {
	test("on the base branch with an untouched index — the working tree alone", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		fixture.write("a.txt", "a2\n");

		assert.deepEqual(await scopeIds(fixture), ["worktree"]);
	});

	test("something staged — the staged scope joins in, and shows the index, not the disk", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		fixture.write("a.txt", "staged\n");
		fixture.git("add", "a.txt");
		fixture.write("a.txt", "staged, then edited again\n");

		const { changesets } = await buildScopes(fixture.options());
		assert.deepEqual(changesets.map((changeset) => changeset.id), ["worktree", "staged"]);

		const staged = changesets.find((changeset) => changeset.id === "staged") as Changeset;
		assert.equal(staged.label, "Staged");
		assert.equal(staged.against, "HEAD");
		assert.equal(soleFile(staged).newText, "staged\n");
		const worktree = changesets.find((changeset) => changeset.id === "worktree") as Changeset;
		assert.equal(soleFile(worktree).newText, "staged, then edited again\n");
	});

	test("on a branch — `since <base>` joins in and covers commits plus the working tree", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		fixture.git("checkout", "-q", "-b", "feature");
		fixture.write("committed.txt", "one\n");
		commitAll(fixture, "on the branch");
		fixture.write("dirty.txt", "two\n");

		const { changesets, activeId } = await buildScopes(fixture.options());
		assert.equal(activeId, "worktree");
		assert.deepEqual(changesets.map((changeset) => changeset.id), ["worktree", "since"]);

		const since = changesets.find((changeset) => changeset.id === "since") as Changeset;
		assert.equal(since.label, "Since main");
		assert.equal(since.against, "main");
		assert.deepEqual(since.files.map((file) => file.path), ["committed.txt", "dirty.txt"]);
		// the working tree alone sees only what is not committed yet
		const worktree = changesets.find((changeset) => changeset.id === "worktree") as Changeset;
		assert.deepEqual(worktree.files.map((file) => file.path), ["dirty.txt"]);
	});

	test("a clean tree on a branch opens on `since` instead of saying \"No changes\"", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		fixture.git("checkout", "-q", "-b", "feature");
		fixture.write("b.txt", "b\n");
		commitAll(fixture, "on the branch");

		const { changesets, activeId } = await buildScopes(fixture.options());
		assert.equal(activeId, "since");
		assert.deepEqual(changesets.map((changeset) => changeset.id), ["since"]);
	});

	test("an explicit revision: one argument is `since`, two are a plain range", async () => {
		const fixture = repo();
		fixture.write("a.txt", "one\n");
		commitAll(fixture, "first");
		fixture.write("a.txt", "two\n");
		commitAll(fixture, "second");
		fixture.write("a.txt", "three\n");

		const since = await buildScopes(fixture.options({ id: "since", ref: "HEAD~1" }));
		assert.equal(since.activeId, "since");
		const sinceSet = since.changesets.find((changeset) => changeset.id === "since") as Changeset;
		assert.equal(sinceSet.label, "Since HEAD~1");
		assert.equal(soleFile(sinceSet).oldText, "one\n");
		assert.equal(soleFile(sinceSet).newText, "three\n");

		const range = await buildScopes(fixture.options({ id: "range", base: "HEAD~1", head: "HEAD" }));
		assert.equal(range.activeId, "range");
		const rangeSet = range.changesets.find((changeset) => changeset.id === "range") as Changeset;
		assert.equal(rangeSet.label, "HEAD~1..HEAD");
		assert.equal(rangeSet.against, "HEAD~1..HEAD");
		// a range is two revisions: the uncommitted "three" is none of its business
		assert.equal(soleFile(rangeSet).newText, "two\n");
	});

	test("an unknown revision is a usage error, not an empty review", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);

		await assert.rejects(
			() => buildScopes(fixture.options({ id: "since", ref: "no-such-branch" })),
			/unknown revision: no-such-branch/,
		);
		await assert.rejects(
			() => buildScopes(fixture.options({ id: "range", base: "HEAD", head: "nope" })),
			/unknown revision: nope/,
		);
	});

	test("--staged with an untouched index: the scope is offered and stays empty", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		fixture.write("a.txt", "a2\n");

		const { changesets, activeId } = await buildScopes(fixture.options({ id: "staged" }));
		// nothing is staged, so there is no staged changeset — and the run refuses to
		// silently review the working tree instead (run.ts turns this into "Nothing staged")
		assert.equal(activeId, null);
		assert.deepEqual(changesets.map((changeset) => changeset.id), ["worktree"]);
	});
});

describe("worktree: applicability boundaries", () => {
	test("outside a git repository: a warning on stderr and an empty list", async () => {
		const fixture = repo(false);
		const captured: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			captured.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let scopes;
		try {
			scopes = await buildScopes(fixture.options());
		} finally {
			process.stderr.write = original;
		}
		assert.deepEqual(scopes, { changesets: [], activeId: null });
		assert.match(captured.join(""), /is not a git repository/);
	});

	test("a state directory inside the repository does not end up in its own diff", async () => {
		// Since D30 the state normally lives outside the tree, but CLAUDE_CONFIG_DIR
		// may point into the repository — and then the pre-D30 failure is back:
		// the previous run's handoff becomes an untracked file of the next one and
		// its text travels into the newText of the new handoff, growing it
		// severalfold per run.
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);

		const options = fixture.options();
		const state = relative(fixture.root, reviewStateDir(fixture.root, options.claudeDir));
		assert.ok(!state.startsWith(".."), "the fixture must put the state inside the repo for this test");
		fixture.write(join(state, "handoff.json"), '{"version":1}\n');
		fixture.write(join(state, "notes-2026-09-14T12-00-00.json"), "[]\n");
		fixture.write("edit.txt", "visible\n");

		const { changesets } = await buildScopes(options);
		assert.deepEqual((changesets[0] as Changeset).files.map((file) => file.path), ["edit.txt"]);
	});

	test("clean working tree, nothing else on offer: no scopes, not an error", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		assert.deepEqual(await buildScopes(fixture.options()), { changesets: [], activeId: null });
	});

	test("files are sorted by path", async () => {
		const fixture = repo();
		fixture.write("b.txt", "b\n");
		commitAll(fixture);
		fixture.write("b.txt", "b2\n");
		fixture.write("z.txt", "z\n");
		fixture.write("a.txt", "a\n");

		const changeset = await worktreeChangeset(fixture);
		assert.deepEqual(
			changeset.files.map((file) => file.path),
			["a.txt", "b.txt", "z.txt"],
		);
	});
});
