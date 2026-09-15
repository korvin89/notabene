// CLI tests via a real `./ntb` run — this also verifies that the executable
// works WITHOUT a controlling terminal (`detached: true` does setsid, exactly
// like Claude Code does for a `!`-command; docs/spike-tty.md).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { claudeFixture } from "./helpers.ts";

const NTB = fileURLToPath(new URL("../ntb", import.meta.url));

// No `./ntb` run may ever happen in the repository root: on a live T5 run
// such a test ate a real unfinished review (pending cleared, the batch went
// into a swallowed stdout). The default directory is temporary and deliberately
// not a git repo.
const SANDBOX = mkdtempSync(join(tmpdir(), "notabene-cli-default-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function cli(
	args: string[],
	options: { env?: NodeJS.ProcessEnv; detached?: boolean; cwd?: string } = {},
): Promise<CliResult> {
	// PATH is needed for `node`; the rest of the environment defaults to empty so
	// tests do not pick up the real Claude Code session they themselves run in.
	const env = options.env ?? { PATH: process.env["PATH"] ?? "" };
	const child = spawn(NTB, args, {
		env,
		cwd: options.cwd ?? SANDBOX,
		detached: options.detached ?? false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/** The prepared review's comment mirror — its name is stored in the handoff. */
function mirrorOf(repo: string): string {
	const handoff = JSON.parse(readFileSync(join(repo, ".claude", "reviews", "handoff.json"), "utf8")) as {
		notesPath: string;
	};
	return handoff.notesPath;
}

/** A session environment where the session resolves, but `~/.claude` is a fixture. */
function sessionEnv(sessionId = "test-session-id"): NodeJS.ProcessEnv {
	return {
		PATH: process.env["PATH"] ?? "",
		CLAUDE_CODE_SESSION_ID: sessionId,
		CLAUDE_CONFIG_DIR: claudeFixture().claudeDir,
	};
}

describe("ntb --version / --help", () => {
	test("--version prints the version to stdout and stays silent on stderr", async () => {
		const result = await cli(["--version"]);
		assert.equal(result.code, 0);
		assert.match(result.stdout, /^ntb \d+\.\d+\.\d+\n$/);
		assert.equal(result.stderr, "");
	});

	test("--version works without a controlling terminal (as under `!`)", async () => {
		const result = await cli(["--version"], { detached: true });
		assert.equal(result.code, 0);
		assert.match(result.stdout, /^ntb \d+\.\d+\.\d+\n$/);
	});

	test("--help describes all three flows", async () => {
		const result = await cli(["--help"]);
		assert.equal(result.code, 0);
		assert.match(result.stdout, /Usage:/);
		assert.match(result.stdout, /ntb collect/);
		assert.match(result.stdout, /ntb dump/);
	});

	test("`help` works as a command too", async () => {
		const result = await cli(["help"]);
		assert.equal(result.code, 0);
		assert.match(result.stdout, /Usage:/);
	});
});

describe("usage errors", () => {
	test("unknown flag: code 2 and empty stdout", async () => {
		const result = await cli(["--no-such-flag"]);
		assert.equal(result.code, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Usage:/);
	});

	test("an unknown command is refused, not guessed at", async () => {
		const result = await cli(["bogus"]);
		assert.equal(result.code, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /unknown command: bogus/);
	});

	// The commands replaced hand-written "these two cannot be combined" checks
	// (D26): a flag now simply does not exist outside the command that uses it.
	test("a flag of another command is a usage error", async () => {
		const launcher = await cli(["collect", "--launcher", "kitty"]);
		assert.equal(launcher.code, 2);
		assert.equal(launcher.stdout, "");
		assert.match(launcher.stderr, /--launcher/);

		const check = await cli(["review", "--check"]);
		assert.equal(check.code, 2);
		assert.match(check.stderr, /--check/);
	});

	test("dump without a source, and with too many", async () => {
		const missing = await cli(["dump"]);
		assert.equal(missing.code, 2);
		assert.match(missing.stderr, /dump expects a source/);

		const extra = await cli(["dump", "current", "turns"]);
		assert.equal(extra.code, 2);
		assert.match(extra.stderr, /one source/);
	});

	test("a stray word after a command is not ignored", async () => {
		const result = await cli(["collect", "oops"]);
		assert.equal(result.code, 2);
		assert.equal(result.stdout, "");
	});

	test("--turn expects a turn number", async () => {
		const result = await cli(["--turn", "late"]);
		assert.equal(result.code, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /--turn/);
	});

	test("--launcher expects a name from the chain", async () => {
		const result = await cli(["--launcher", "tmux"]);
		assert.equal(result.code, 2);
		assert.match(result.stderr, /herdr, kitty, manual/);
	});

	test("unknown source for dump", async () => {
		const result = await cli(["dump", "whatever"], { env: sessionEnv() });
		assert.equal(result.code, 2);
		assert.equal(result.stdout, "");
	});
});

describe("session resolution on a live run", () => {
	test("outside a Claude Code session — a clear error and empty stdout", async () => {
		const result = await cli([], { env: { PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: claudeFixture().claudeDir } });
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /determine the Claude Code session/);
	});

	test("dump session returns JSON with origin=env", async () => {
		const result = await cli(["dump", "session"], { env: sessionEnv("session-from-env") });
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.stdout), {
			sessionId: "session-from-env",
			cwd: realpathSync(SANDBOX),
			transcriptPath: null,
			claudePid: null,
			origin: "env",
		});
	});

	test("dump env returns the launcher detection result", async () => {
		const env = { ...sessionEnv(), KITTY_LISTEN_ON: "unix:/tmp/kitty-777" };
		const result = await cli(["dump", "env"], { env });
		assert.equal(result.code, 0);

		const detected = JSON.parse(result.stdout) as Record<string, { available: boolean }>;
		assert.equal(detected["herdr"]?.available, false);
		assert.equal(detected["kitty"]?.available, true);
		assert.equal(detected["manual"]?.available, true);
	});
});

describe("stdout stays empty while there is no batch", () => {
	test("outside a git repo: a warning, \"No changes\", code 0, empty stdout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-cli-"));
		try {
			const result = await cli([], { env: sessionEnv(), cwd: dir });
			assert.equal(result.code, 0);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /not a git repository/);
			assert.match(result.stderr, /No changes/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("git repo with changes, no viewers around: preparation + flow C instructions, stdout empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-cli-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
			writeFileSync(join(dir, "new.txt"), "line\n");
			const result = await cli([], { env: sessionEnv(), cwd: dir });
			assert.equal(result.code, 0);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /ntb open/);
			assert.match(result.stderr, /ntb collect/);
			// preparation is in place: pending for collect, handoff for the viewer
			assert.ok(existsSync(join(dir, ".claude", "reviews", "pending.json")));
			assert.ok(existsSync(join(dir, ".claude", "reviews", "handoff.json")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("--turn 3 without a transcript: turns (T4) degrades to current, stdout empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-cli-"));
		try {
			const result = await cli(["--turn", "T3"], { env: sessionEnv(), cwd: dir });
			assert.equal(result.code, 0);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /per-turn diff unavailable/);
			assert.match(result.stderr, /No changes/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// cwd is mandatory: without it the collection would run in the repository root
	// and grab the developer's real unfinished review (caught on a live T5 run).
	test("collect without a started session: a clear error (T6), stdout empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-cli-"));
		try {
			const result = await cli(["collect"], { env: sessionEnv(), cwd: dir });
			assert.equal(result.code, 1);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /nothing to collect/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("flow C end to end, headless (T5 DoD: comments are available programmatically)", () => {
	test("!ntb → ntb open (viewer stub) → !ntb collect → batch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-cli-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
			writeFileSync(join(dir, "new.txt"), "first\nsecond\n");

			// Step 1: preparation from the "session" (no terminal under `!` — instructions)
			const prepare = await cli([], { env: sessionEnv(), cwd: dir, detached: true });
			assert.equal(prepare.code, 0);
			assert.equal(prepare.stdout, "");

			// Step 2: `ntb open` in a "second terminal" — no session, the viewer
			// is replaced with a stub that writes the mirror the way the extension
			// would after a live review (the TUI itself never runs in tests).
			const reviews = join(dir, ".claude", "reviews");
			const viewer = join(dir, "viewer-stub.sh");
			const notes = JSON.stringify([
				{
					id: "user:1-1",
					source: "user",
					file: "new.txt",
					side: "new",
					oldRange: null,
					newRange: [2, 2],
					body: "[q] why the second line?",
				},
			]);
			// Each review has its own mirror path — the viewer learns it from the
			// handoff, exactly like the real extension (env NOTABENE_HANDOFF).
			writeFileSync(viewer, `#!/bin/sh\nprintf %s '${notes}' > "${mirrorOf(dir)}"\n`);
			chmodSync(viewer, 0o755);
			const open = await cli(["open"], {
				env: {
					PATH: process.env["PATH"] ?? "",
					CLAUDE_CONFIG_DIR: claudeFixture().claudeDir,
					NOTABENE_TTY: "1",
					NOTABENE_HUNK: viewer,
				},
				cwd: dir,
			});
			assert.equal(open.code, 0);
			assert.equal(open.stdout, "");
			assert.match(open.stderr, /ntb collect/);

			// a leftover of the mirror's temp file (hunk was killed mid-write)
			writeFileSync(`${mirrorOf(dir)}.tmp`, "[{incomplete");

			// Step 3: collection from the "session" — the batch to stdout, the JSON copy next to it
			const collect = await cli(["collect"], { env: sessionEnv(), cwd: dir, detached: true });
			assert.equal(collect.code, 0);
			assert.match(collect.stdout, /Review of the current state diff, 1 comment\./);
			assert.match(collect.stdout, /@new\.txt:2 \[question\]/);
			assert.match(collect.stdout, /why the second line\?/);
			assert.match(collect.stdout, /Machine-readable copy: \.claude\/reviews\/.+\.json/);

			// the session is closed: no service files remain, the review history does
			assert.deepEqual(
				readdirSync(reviews).filter((name) => !/^\d{4}-/.test(name)),
				[],
				"handoff, pending, and mirrors (including .tmp) must be gone",
			);
			const saved = readdirSync(reviews).filter((name) => /^\d{4}-/.test(name));
			assert.equal(saved.length, 1);
			const document = JSON.parse(readFileSync(join(reviews, saved[0] as string), "utf8"));
			assert.equal(document.comments.length, 1);
			assert.equal(document.comments[0].type, "question");

			const again = await cli(["collect"], { env: sessionEnv(), cwd: dir });
			assert.equal(again.code, 1);
			assert.match(again.stderr, /nothing to collect/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a review cancelled in the viewer (x) delivers nothing, comments and all", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-cancel-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
			writeFileSync(join(dir, "new.txt"), "first\nsecond\n");
			assert.equal((await cli([], { env: sessionEnv(), cwd: dir, detached: true })).code, 0);

			// The stub does what the extension's Cancel does: the comments are in
			// the mirror, and next to it the outcome marker.
			const notes = JSON.stringify([
				{ id: "user:1-1", source: "user", file: "new.txt", side: "new", oldRange: null, newRange: [2, 2], body: "never mind" },
			]);
			const viewer = join(dir, "viewer-cancel.sh");
			const outcome = mirrorOf(dir).replace(/\.json$/, ".outcome.json");
			writeFileSync(
				viewer,
				`#!/bin/sh\nprintf %s '${notes}' > "${mirrorOf(dir)}"\n`
					+ `printf %s '{"version":1,"outcome":"cancelled"}' > "${outcome}"\n`,
			);
			chmodSync(viewer, 0o755);
			const open = await cli(["open"], {
				env: {
					PATH: process.env["PATH"] ?? "",
					CLAUDE_CONFIG_DIR: claudeFixture().claudeDir,
					NOTABENE_TTY: "1",
					NOTABENE_HUNK: viewer,
				},
				cwd: dir,
			});
			assert.equal(open.code, 0);

			const collect = await cli(["collect"], { env: sessionEnv(), cwd: dir, detached: true });
			assert.equal(collect.code, 0);
			assert.equal(collect.stdout, "", "a cancelled review must not reach Claude");
			assert.match(collect.stderr, /cancelled/i);
			assert.match(collect.stderr, /1 comment discarded/);

			// The session is closed exactly as a delivered one, minus the JSON copy:
			// nothing was reviewed, so there is no history to keep.
			const reviews = join(dir, ".claude", "reviews");
			assert.deepEqual(readdirSync(reviews), [], "handoff, pending, mirror and marker must be gone");

			// and there is nothing left to collect a second time
			const again = await cli(["collect"], { env: sessionEnv(), cwd: dir });
			assert.equal(again.code, 1);
			assert.match(again.stderr, /nothing to collect/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Ctrl-C in the flow C viewer", () => {
	test("an interrupted viewer — code 130 and a hint about collect, not a \"viewer error\"", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-sigint-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
			writeFileSync(join(dir, "new.txt"), "line\n");
			assert.equal((await cli([], { env: sessionEnv(), cwd: dir, detached: true })).code, 0);

			// a viewer "killed" by Ctrl-C: the signal goes to the whole process group
			const viewer = join(dir, "viewer-sigint.sh");
			writeFileSync(viewer, "#!/bin/sh\nkill -INT $$\n");
			chmodSync(viewer, 0o755);
			const result = await cli(["open"], {
				env: {
					PATH: process.env["PATH"] ?? "",
					CLAUDE_CONFIG_DIR: claudeFixture().claudeDir,
					NOTABENE_TTY: "1",
					NOTABENE_HUNK: viewer,
				},
				cwd: dir,
			});
			assert.equal(result.code, 130);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /interrupted \(SIGINT\)/);
			assert.match(result.stderr, /ntb collect/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parallel reviews in one repo (T7): diagnostics instead of silent corruption", () => {
	// handoff/notes/pending in `.claude/reviews/` are per-repository (T5 journal);
	// a second `!ntb` used to silently overwrite them and wipe the open viewer's
	// comment mirror. Now — a refusal with a hint about `collect`.
	test("a second !ntb over an unfinished session: code 1, mirror and pending intact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-cli-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
			writeFileSync(join(dir, "new.txt"), "first\nsecond\n");
			const reviews = join(dir, ".claude", "reviews");

			const first = await cli([], { env: sessionEnv(), cwd: dir, detached: true });
			assert.equal(first.code, 0);
			const pendingBefore = readFileSync(join(reviews, "pending.json"), "utf8");

			// "the first review's viewer" already left a comment in the mirror
			const note = JSON.stringify([
				{ id: "user:1-1", source: "user", file: "new.txt", side: "new", newRange: [1, 1], body: "do not touch" },
			]);
			const mirror = mirrorOf(dir);
			writeFileSync(mirror, note);

			const second = await cli([], { env: sessionEnv(), cwd: dir, detached: true });
			assert.equal(second.code, 1);
			assert.equal(second.stdout, "");
			assert.match(second.stderr, /unfinished review/);
			assert.match(second.stderr, /ntb collect/);
			// nothing overwritten: the first review's mirror and pending are in place
			assert.equal(readFileSync(mirror, "utf8"), note);
			assert.equal(readFileSync(join(reviews, "pending.json"), "utf8"), pendingBefore);

			// the first review's comment is delivered as if nothing happened
			const collect = await cli(["collect"], { env: sessionEnv(), cwd: dir, detached: true });
			assert.equal(collect.code, 0);
			assert.match(collect.stdout, /do not touch/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the review root is the repository root, not the session cwd", () => {
	// Claude Code started in a subdirectory used to get `.claude/reviews/` in the
	// subdirectory and a handoff.root that did not match the patch paths (git
	// always prints them from the root) — the batch reference did not resolve
	// from the agent's cwd.
	test("a session in a subdirectory: service files and paths are computed from the repo root", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "notabene-root-")));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
			const deep = join(dir, "pkg", "deep");
			execFileSync("mkdir", ["-p", deep]);
			writeFileSync(join(deep, "inner.txt"), "inside\n");
			writeFileSync(join(dir, "root.txt"), "root\n");

			const result = await cli([], { env: sessionEnv(), cwd: deep, detached: true });
			assert.equal(result.code, 0);
			assert.equal(result.stdout, "");

			// the review directory is in the repository root, not in the subdirectory
			assert.ok(existsSync(join(dir, ".claude", "reviews", "handoff.json")));
			assert.ok(!existsSync(join(deep, ".claude")));

			const handoff = JSON.parse(readFileSync(join(dir, ".claude", "reviews", "handoff.json"), "utf8")) as {
				root: string;
				changesets: { files: { path: string }[]; patchText: string }[];
			};
			assert.equal(handoff.root, dir);
			assert.deepEqual(
				(handoff.changesets[0]?.files ?? []).map((file) => file.path),
				["pkg/deep/inner.txt", "root.txt"],
			);
			// patch paths and the adapter's repoRoot now share one coordinate system
			assert.match(handoff.changesets[0]?.patchText ?? "", /^diff --git a\/pkg\/deep\/inner\.txt /);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("a failed viewer launch does not leave a session behind", () => {
	// Otherwise the `pending.json` of a viewer that never opened would bounce every
	// subsequent `!ntb` with "the viewer may still be open" — until a manual `collect`.
	test("kitty failed to open a tab: code 1, pending cleared, the next run goes through", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notabene-fail-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
			writeFileSync(join(dir, "new.txt"), "line\n");
			const kitty = join(dir, "kitty-fail.sh");
			writeFileSync(kitty, "#!/bin/sh\necho 'no matching window' >&2\nexit 1\n");
			chmodSync(kitty, 0o755);
			const env = {
				...sessionEnv(),
				KITTY_LISTEN_ON: "unix:/tmp/kitty-test",
				NOTABENE_KITTY: kitty,
				NOTABENE_HUNK: "/bin/echo",
			};

			const failed = await cli([], { env, cwd: dir, detached: true });
			assert.equal(failed.code, 1);
			assert.equal(failed.stdout, "");
			assert.match(failed.stderr, /did not open a tab/);
			assert.ok(!existsSync(join(dir, ".claude", "reviews", "pending.json")), "pending must be cleared");

			// the next run does not trip over someone else's session
			const next = await cli([], { env: sessionEnv(), cwd: dir, detached: true });
			assert.equal(next.code, 0);
			assert.doesNotMatch(next.stderr, /unfinished review/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ntb dump turns on the fixture session (T4 DoD)", () => {
	test("the list of turns with labels and diffs arrives as JSON in stdout", async () => {
		const env = {
			PATH: process.env["PATH"] ?? "",
			CLAUDE_CODE_SESSION_ID: "d961755c-b183-4b29-b17d-ef95589d3e72",
			CLAUDE_CONFIG_DIR: fileURLToPath(new URL("./fixtures/turns/main-claude", import.meta.url)),
		};
		const result = await cli(["dump", "turns"], { env, detached: true });
		assert.equal(result.code, 0);
		assert.equal(result.stderr, "");

		const changesets = JSON.parse(result.stdout) as {
			id: string;
			label: string;
			promptSnippet?: string;
			files: { path: string; hunks: unknown[] }[];
		}[];
		assert.deepEqual(
			changesets.map((changeset) => changeset.id),
			["T14", "T13", "T12", "T11", "T10", "T9", "T6", "T4", "T2"],
		);
		for (const changeset of changesets) {
			assert.ok(changeset.label.includes(changeset.promptSnippet ?? "???"));
			assert.ok(changeset.files.length > 0);
			for (const file of changeset.files) assert.ok(file.hunks.length > 0);
		}
	});
});
