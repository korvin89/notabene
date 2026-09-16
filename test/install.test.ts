// Installer and updater e2e (ARCHITECTURE.md §7): `install.sh` against a local
// git remote, then `ntb update` onto a newer tag.
//
// `npm` is stubbed the same way kitty and herdr are in the launcher tests: the
// real `npm ci` downloads a ~100 MB viewer binary, which has no place in a test
// run. Everything else — git, node, the installed CLI — is real.
//
// No test may touch the developer's own install: HOME, NOTABENE_ROOT and
// NOTABENE_BINDIR all point into a temp directory (the same rule as the `cwd` of
// the CLI tests).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALL_SH = join(REPO_ROOT, "install.sh");

const WORK = mkdtempSync(join(tmpdir(), "notabene-install-"));
after(() => rmSync(WORK, { recursive: true, force: true }));

/** git with a fixed identity: the test must not depend on the developer's global config. */
function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** The version a fresh fixture starts at, whatever this repository is at. */
const FIXTURE_VERSION = "0.1.0";

function setVersion(remote: string, version: string): void {
	const manifest = JSON.parse(readFileSync(join(remote, "package.json"), "utf8")) as Record<string, unknown>;
	manifest["version"] = version;
	writeFileSync(join(remote, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * A remote carrying the real product files — `src/update.ts` under test is the
 * installed copy, not this repository's.
 *
 * The copied `package.json` gets an explicit version, because these tests assert
 * on what `ntb --version` prints: inheriting the repository's own version made
 * them pass only while it happened to be `0.1.0`, and they broke the moment
 * release-please bumped it (ARCHITECTURE.md §7.1 — the version moves on its own now).
 */
function makeRemote(name: string, options: { tag?: string } = {}): string {
	const remote = join(WORK, name);
	mkdirSync(remote, { recursive: true });
	git(remote, ["init", "--quiet", "-b", "main"]);
	for (const entry of ["ntb", "package.json", "package-lock.json"]) {
		cpSync(join(REPO_ROOT, entry), join(remote, entry));
	}
	cpSync(join(REPO_ROOT, "src"), join(remote, "src"), { recursive: true });
	// The plugin rides along because `ntb update` diffs `.claude-plugin/skills`
	// between tags to decide whether the plugin hint is worth printing.
	cpSync(join(REPO_ROOT, ".claude-plugin"), join(remote, ".claude-plugin"), { recursive: true });
	chmodSync(join(remote, "ntb"), 0o755);
	setVersion(remote, FIXTURE_VERSION);
	git(remote, ["add", "-A"]);
	git(remote, ["commit", "--quiet", "-m", "initial"]);
	if (options.tag !== undefined) git(remote, ["tag", options.tag]);
	return remote;
}

/**
 * Publishes a new version on the remote: bumps package.json and tags it.
 * `skill` edits the agent-facing instruction in the same release — the only
 * change that makes `ntb update` mention the plugin at all.
 */
function release(remote: string, version: string, tag: string, options: { skill?: boolean } = {}): void {
	setVersion(remote, version);
	if (options.skill === true) {
		const path = join(remote, ".claude-plugin", "skills", "ntb", "SKILL.md");
		writeFileSync(path, `${readFileSync(path, "utf8")}\nA line the agent now reads.\n`);
	}
	git(remote, ["add", "-A"]);
	git(remote, ["commit", "--quiet", "-m", version]);
	git(remote, ["tag", tag]);
}

/** What Claude Code records about an installed plugin (src/plugin.ts). */
function recordPlugin(install: Install, version: string | null): void {
	const dir = join(install.home, ".claude", "plugins");
	mkdirSync(dir, { recursive: true });
	const plugins = version === null ? {} : { "ntb@notabene": [{ scope: "user", version }] };
	writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }, null, 2));
}

/** A PATH whose `npm` does nothing: the dependency download is not under test. */
function stubNpm(name: string): string {
	const dir = join(WORK, name);
	mkdirSync(dir, { recursive: true });
	const npm = join(dir, "npm");
	writeFileSync(npm, '#!/bin/sh\nmkdir -p node_modules\nexit 0\n');
	chmodSync(npm, 0o755);
	return dir;
}

interface Install {
	root: string;
	bindir: string;
	home: string;
	env: NodeJS.ProcessEnv;
}

function installPaths(name: string): Install {
	const home = join(WORK, name);
	const root = join(home, "share", "notabene");
	const bindir = join(home, "bin");
	mkdirSync(home, { recursive: true });
	return {
		root,
		bindir,
		home,
		env: {
			PATH: `${stubNpm(`${name}-stub`)}:${process.env["PATH"] ?? ""}`,
			HOME: home,
			NOTABENE_ROOT: root,
			NOTABENE_BINDIR: bindir,
		},
	};
}

interface Run {
	stdout: string;
	stderr: string;
	code: number;
}

/** Both streams are needed: the installer and `update` speak on stderr only. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Run {
	const result = spawnSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.error !== undefined) throw result.error;
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
}

function runInstaller(install: Install, remote: string, args: string[] = []): Run {
	return run("sh", [INSTALL_SH, ...args], { ...install.env, NOTABENE_REPO: remote });
}

/** The installed CLI, run exactly as a user would: through the symlink on PATH. */
function ntb(install: Install, args: string[]): Run {
	return run(join(install.bindir, "ntb"), args, { PATH: install.env["PATH"] ?? "", HOME: install.home });
}

describe("install.sh", () => {
	test("clones the newest tag, links both names, marks the directory", () => {
		const remote = makeRemote("remote-tagged", { tag: "v0.1.0" });
		release(remote, "0.2.0", "v0.2.0");
		const install = installPaths("install-tagged");

		assert.equal(runInstaller(install, remote).code, 0);

		assert.ok(existsSync(join(install.root, ".managed-install")), "the marker must be written");
		// The newest tag wins over the default branch — v0.2.0, not the v0.1.0 commit.
		assert.equal(git(install.root, ["describe", "--tags", "--exact-match", "HEAD"]).trim(), "v0.2.0");

		for (const name of ["ntb", "notabene"]) {
			const link = join(install.bindir, name);
			assert.ok(lstatSync(link).isSymbolicLink(), `${name} must be a symlink`);
			assert.equal(readlinkSync(link), join(install.root, "ntb"));
		}

		// The whole point of the symlinks: the CLI runs from PATH, resolving back
		// to the install root (the sh wrapper walks the symlink chain).
		assert.equal(ntb(install, ["--version"]).stdout.trim(), "ntb 0.2.0");
	});

	test("--ref pins an older release instead of the newest", () => {
		const remote = makeRemote("remote-pinned", { tag: "v0.1.0" });
		release(remote, "0.2.0", "v0.2.0");
		const install = installPaths("install-pinned");

		assert.equal(runInstaller(install, remote, ["--ref", "v0.1.0"]).code, 0);

		assert.equal(ntb(install, ["--version"]).stdout.trim(), "ntb 0.1.0");
	});

	test("an unknown flag stops the installer before it touches anything", () => {
		const remote = makeRemote("remote-badflag", { tag: "v0.1.0" });
		const install = installPaths("install-badflag");

		const result = runInstaller(install, remote, ["--branch", "main"]);

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /unknown option: --branch/);
		assert.ok(!existsSync(install.root), "nothing may be installed on a usage error");
	});

	test("an unreleased remote installs the default branch", () => {
		const remote = makeRemote("remote-untagged");
		const install = installPaths("install-untagged");

		const result = runInstaller(install, remote);

		assert.equal(result.code, 0);
		assert.match(result.stderr, /no tags yet/);
		assert.equal(git(install.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
		assert.equal(ntb(install, ["--version"]).code, 0);
	});

	// Version sort ranks anything lexically above `v` — `wip-hunk-spike` included —
	// higher than every version tag, so without the glob a stray tag is what users
	// would get (ARCHITECTURE.md §7).
	test("a tag that is not a release is never an install target", () => {
		const remote = makeRemote("remote-stray", { tag: "v0.1.0" });
		release(remote, "0.2.0", "v0.2.0");
		release(remote, "9.9.9", "wip-hunk-spike");
		const install = installPaths("install-stray");

		assert.equal(runInstaller(install, remote).code, 0);

		assert.equal(ntb(install, ["--version"]).stdout.trim(), "ntb 0.2.0");
	});

	test("re-running the installer updates in place instead of failing", () => {
		const remote = makeRemote("remote-rerun", { tag: "v0.1.0" });
		const install = installPaths("install-rerun");
		runInstaller(install, remote);
		assert.equal(ntb(install, ["--version"]).stdout.trim(), "ntb 0.1.0");

		release(remote, "0.3.0", "v0.3.0");
		runInstaller(install, remote);

		assert.equal(ntb(install, ["--version"]).stdout.trim(), "ntb 0.3.0");
	});

	test("refuses to adopt a directory it did not create", () => {
		const remote = makeRemote("remote-foreign", { tag: "v0.1.0" });
		const install = installPaths("install-foreign");
		// A developer's checkout looks like an install minus the marker; overwriting
		// it would discard unfinished work.
		mkdirSync(install.root, { recursive: true });
		writeFileSync(join(install.root, "precious.txt"), "unfinished work");

		const result = runInstaller(install, remote);

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /was not created by this installer/);
		assert.ok(existsSync(join(install.root, "precious.txt")), "nothing may be touched on refusal");
	});

	test("refuses to overwrite a foreign binary of the same name", () => {
		const remote = makeRemote("remote-collide", { tag: "v0.1.0" });
		const install = installPaths("install-collide");
		mkdirSync(install.bindir, { recursive: true });
		writeFileSync(join(install.bindir, "ntb"), "#!/bin/sh\necho someone else\n");

		const result = runInstaller(install, remote);

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /is not our symlink/);
		assert.match(readFileSync(join(install.bindir, "ntb"), "utf8"), /someone else/);
	});
});

describe("ntb update", () => {
	test("moves a managed install to the newest release", () => {
		const remote = makeRemote("remote-update", { tag: "v0.1.0" });
		const install = installPaths("install-update");
		runInstaller(install, remote);

		release(remote, "0.4.0", "v0.4.0");
		const result = ntb(install, ["update"]);

		assert.equal(result.code, 0);
		assert.equal(result.stdout, "", "maintenance output must not touch stdout");
		assert.match(result.stderr, /updating to v0\.4\.0/);
		assert.equal(ntb(install, ["--version"]).stdout.trim(), "ntb 0.4.0");
	});

	test("reports when already current, and --check changes nothing", () => {
		const remote = makeRemote("remote-current", { tag: "v0.1.0" });
		const install = installPaths("install-current");
		runInstaller(install, remote);

		assert.match(ntb(install, ["update"]).stderr, /already on the newest release \(v0\.1\.0\)/);

		release(remote, "0.5.0", "v0.5.0");
		const checked = ntb(install, ["update", "--check"]);
		assert.match(checked.stderr, /a newer release is available: v0\.5\.0/);
		assert.equal(ntb(install, ["--version"]).stdout.trim(), "ntb 0.1.0", "--check must not install anything");
	});

	// The plugin is the other half of the install (§7.2) and updates by its own
	// path. `ntb update` is where the drift is visible, so it reports it — but
	// only when it is real, because a hint that fires every release is ignored.
	test("no plugin installed: the update says so and prints the two lines", () => {
		const remote = makeRemote("remote-noplugin", { tag: "v0.1.0" });
		const install = installPaths("install-noplugin");
		runInstaller(install, remote);
		release(remote, "0.2.0", "v0.2.0");

		const result = ntb(install, ["update"]);

		assert.equal(result.stdout, "", "the hint is diagnostics, not a batch");
		assert.match(result.stderr, /plugin is not installed/);
		assert.match(result.stderr, /\/plugin marketplace add korvin89\/notabene/);
		assert.match(result.stderr, /\/plugin install ntb@notabene/);
	});

	test("plugin behind and the skill changed: the update says how to catch it up", () => {
		const remote = makeRemote("remote-plugin-stale", { tag: "v0.1.0" });
		const install = installPaths("install-plugin-stale");
		runInstaller(install, remote);
		recordPlugin(install, "0.1.0");
		release(remote, "0.2.0", "v0.2.0", { skill: true });

		const result = ntb(install, ["update"]);

		assert.match(result.stderr, /plugin is at 0\.1\.0 and still ships that skill, while this CLI is 0\.2\.0/);
		assert.match(result.stderr, /\/plugin update ntb@notabene/);
		// the step people miss, and the CLI's own help is where we learned it
		assert.match(result.stderr, /restart Claude Code/);
	});

	test("plugin behind but the skill untouched: not a word about it", () => {
		const remote = makeRemote("remote-plugin-quiet", { tag: "v0.1.0" });
		const install = installPaths("install-plugin-quiet");
		runInstaller(install, remote);
		recordPlugin(install, "0.1.0");
		// a plain release: release-please would still bump the plugin manifest, so
		// the version gap is real — the skill is not, and that is what decides
		release(remote, "0.2.0", "v0.2.0");

		const result = ntb(install, ["update"]);

		assert.equal(result.code, 0);
		assert.match(result.stderr, /updated to v0\.2\.0/);
		assert.doesNotMatch(result.stderr, /\/plugin/, "a version gap alone is not worth a hint");
	});

	test("plugin level with the CLI: silence", () => {
		const remote = makeRemote("remote-plugin-level", { tag: "v0.1.0" });
		const install = installPaths("install-plugin-level");
		runInstaller(install, remote);
		recordPlugin(install, "0.2.0");
		release(remote, "0.2.0", "v0.2.0", { skill: true });

		const result = ntb(install, ["update"]);

		assert.doesNotMatch(result.stderr, /\/plugin/);
	});

	test("a stray tag on the remote is not a newer release", () => {
		const remote = makeRemote("remote-stray-update", { tag: "v0.1.0" });
		const install = installPaths("install-stray-update");
		runInstaller(install, remote);

		release(remote, "9.9.9", "wip-hunk-spike");
		const result = ntb(install, ["update", "--check"]);

		assert.match(result.stderr, /already on the newest release \(v0\.1\.0\)/);
	});

	test("refuses to update an unmarked checkout", () => {
		const remote = makeRemote("remote-unmarked", { tag: "v0.1.0" });
		const install = installPaths("install-unmarked");
		runInstaller(install, remote);
		rmSync(join(install.root, ".managed-install"));

		const result = ntb(install, ["update"]);

		assert.equal(result.code, 1);
		assert.match(result.stderr, /not a managed install/);
	});

	// `--check` belongs to `update` and exists nowhere else — that is structural
	// now, not a hand-written compatibility check (D26).
	test("--check outside the update command is a usage error", () => {
		const remote = makeRemote("remote-usage", { tag: "v0.1.0" });
		const install = installPaths("install-usage");
		runInstaller(install, remote);

		const result = ntb(install, ["--check"]);

		assert.equal(result.code, 2);
		assert.match(result.stderr, /--check/);
	});
});
