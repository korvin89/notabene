// Tests of the "current" source (T3) on fixture git repositories: every test
// does git init/commits in a temp directory itself, after() cleans up for everyone.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { after, describe, test } from "node:test";
import { currentChangesets, parseGitPatch } from "../src/diff/current.ts";
import type { DiffSourceOptions } from "../src/diff/index.ts";
import type { Changeset, FileDiff } from "../src/model/diff.ts";
import type { SessionInfo } from "../src/session/types.ts";

// The source inherits the process environment — detach it from the user's
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
	options(): DiffSourceOptions;
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
	const session: SessionInfo = {
		sessionId: "t3-test",
		cwd: root,
		transcriptPath: null,
		claudePid: null,
		origin: "env",
	};
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
		options: () => ({ cwd: root, session, claudeDir: join(root, "no-such-.claude") }),
	};
	if (init) fixture.git("init", "-q", "-b", "main");
	return fixture;
}

function commitAll(fixture: RepoFixture, message = "fixture"): void {
	fixture.git("add", "-A");
	fixture.git("commit", "-q", "-m", message);
}

/** The single changeset from the answer + a check of its shape. */
async function soleChangeset(fixture: RepoFixture): Promise<Changeset> {
	const changesets = await currentChangesets(fixture.options());
	assert.equal(changesets.length, 1);
	const changeset = changesets[0] as Changeset;
	assert.equal(changeset.id, "current");
	assert.equal(changeset.mode, "current");
	assert.equal(changeset.root, fixture.root);
	assert.notEqual(changeset.files.length, 0);
	return changeset;
}

function soleFile(changeset: Changeset): FileDiff {
	assert.equal(changeset.files.length, 1);
	return changeset.files[0] as FileDiff;
}

describe("current: modified and new files", () => {
	test("modified file: hunk, line numbering, oldText/newText", async () => {
		const fixture = repo();
		fixture.write("src/app.ts", "one\ntwo\nthree\n");
		commitAll(fixture);
		fixture.write("src/app.ts", "one\ntwo!\nthree\nfour\n");

		const file = soleFile(await soleChangeset(fixture));
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
		const file = soleFile(await soleChangeset(fixture));
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

		const file = soleFile(await soleChangeset(fixture));
		assert.equal(file.changeKind, "added");
		assert.equal(file.newText, "line\n");
		assert.equal(file.hunks.length, 1);
	});
});

describe("current: deletion and rename", () => {
	test("deleted file: oldText present, newText absent", async () => {
		const fixture = repo();
		fixture.write("gone.txt", "bye\n");
		commitAll(fixture);
		fixture.rm("gone.txt");

		const file = soleFile(await soleChangeset(fixture));
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

		const file = soleFile(await soleChangeset(fixture));
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

		const file = soleFile(await soleChangeset(fixture));
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

describe("current: binary and empty files", () => {
	test("binaries: modified (even with a space in the name) and untracked", async () => {
		const fixture = repo();
		fixture.write("bin/im age.bin", Buffer.from([0x00, 0x01, 0x02, 0xff]));
		commitAll(fixture);
		fixture.write("bin/im age.bin", Buffer.from([0x00, 0xaa, 0xbb]));
		fixture.write("raw.bin", Buffer.from([0x7f, 0x00, 0x45, 0x4c, 0x46]));

		const changeset = await soleChangeset(fixture);
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

		const changeset = await soleChangeset(fixture);
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

		const file = soleFile(await soleChangeset(fixture));
		assert.equal(file.changeKind, "modified");
		assert.equal(file.oldText, "content\n");
		assert.equal(file.newText, "");
		assert.deepEqual(file.hunks[0]?.lines, [{ kind: "del", oldLine: 1, newLine: null, text: "content" }]);
	});
});

describe("current: applicability boundaries", () => {
	test("outside a git repository: a warning on stderr and an empty list", async () => {
		const fixture = repo(false);
		const captured: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			captured.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let changesets;
		try {
			changesets = await currentChangesets(fixture.options());
		} finally {
			process.stderr.write = original;
		}
		assert.deepEqual(changesets, []);
		assert.match(captured.join(""), /is not a git repository/);
	});

	test("the review's own service files do not end up in its own diff", async () => {
		// Without this the handoff of the previous run becomes an untracked file of the
		// next one, its text travels into the newText of the new handoff — which then
		// grows severalfold per run.
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		fixture.write(".claude/reviews/handoff.json", '{"version":1}\n');
		fixture.write(".claude/reviews/notes-2026-09-14T12-00-00.json", "[]\n");
		fixture.write("edit.txt", "visible\n");

		const changeset = await soleChangeset(fixture);
		assert.deepEqual(changeset.files.map((file) => file.path), ["edit.txt"]);
	});

	test("clean working tree: an empty list, not an error", async () => {
		const fixture = repo();
		fixture.write("a.txt", "a\n");
		commitAll(fixture);
		assert.deepEqual(await currentChangesets(fixture.options()), []);
	});

	test("files are sorted by path", async () => {
		const fixture = repo();
		fixture.write("b.txt", "b\n");
		commitAll(fixture);
		fixture.write("b.txt", "b2\n");
		fixture.write("z.txt", "z\n");
		fixture.write("a.txt", "a\n");

		const changeset = await soleChangeset(fixture);
		assert.deepEqual(
			changeset.files.map((file) => file.path),
			["a.txt", "b.txt", "z.txt"],
		);
	});
});

describe("parseGitPatch: edge-case markup that is inconvenient to get from live git", () => {
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
