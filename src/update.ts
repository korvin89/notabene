// `ntb update` — the second half of install.sh (ARCHITECTURE.md §7).
//
// The installer owns one directory and marks it with `.managed-install`; this
// module updates that same directory and refuses to touch anything else. The
// refusal is the point: a developer's checkout looks identical to a managed
// install except for the marker, and `checkout` there would discard work in
// progress.
//
// Releases are git tags, so the whole mechanism is git — no HTTP client, no
// registry API, no rate limits. That keeps the "zero runtime dependencies"
// invariant intact for the update path too.
//
// Output goes to stderr only (§3.1): `update` is a maintenance command, and
// the stdout contract is not worth an exception.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { EXIT, ReviewError, log } from "./io.ts";
import type { ExitCode } from "./io.ts";
import { compareVersions, installedPluginVersion } from "./plugin.ts";

const execFileAsync = promisify(execFile);

/** Install root: this file is `<root>/src/update.ts`. */
const ROOT = join(import.meta.dirname, "..");

const MARKER = join(ROOT, ".managed-install");

/** `npm ci` downloads a ~100 MB viewer binary; the default timeout is far too short. */
const NPM_TIMEOUT_MS = 10 * 60 * 1000;

async function git(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", ROOT, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	return stdout.trim();
}

function installedVersion(): string {
	try {
		const raw = readFileSync(join(ROOT, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		if (typeof parsed.version === "string") return parsed.version;
	} catch {
		// the version is not worth crashing over
	}
	return "0.0.0";
}

/**
 * Newest release tag by version order. Empty string when the repository has no
 * releases — an unreleased remote is a normal state, not a failure.
 *
 * Two things keep "newest" well defined. The `v[0-9]*` glob: a tag that is not
 * `vX.Y.Z` is not a release, and version sort happily ranks `wip-spike` above
 * every version tag. And the rule that there are no pre-release tags at all
 * (ARCHITECTURE.md §7) — the glob would not catch those, and git's version sort
 * puts `v1.0.0-rc.1` *above* `v1.0.0`, so an rc would become everyone's update.
 */
async function latestTag(): Promise<string> {
	const tags = await git(["tag", "--list", "v[0-9]*", "--sort=-v:refname"]);
	return tags.split("\n")[0]?.trim() ?? "";
}

/** The tag HEAD currently sits on, or "" when the checkout is not on a tag. */
async function currentTag(): Promise<string> {
	try {
		return await git(["describe", "--tags", "--exact-match", "HEAD"]);
	} catch {
		return "";
	}
}

export interface UpdateOptions {
	/** Only report whether a newer release exists; change nothing. */
	readonly checkOnly: boolean;
	/** Claude Code state directory — it holds the plugin's installation record (§7.2). */
	readonly claudeDir: string;
}

/**
 * Did this release change the skill — the only thing the plugin ships that the
 * agent reads? A version gap on its own means nothing: release-please bumps the
 * manifests on EVERY release (§7.1, `extra-files`), so `.claude-plugin/` always
 * differs between two tags, and a hint that fires every time is a hint people
 * learn to skip.
 *
 * Hence `skills/` and not the whole directory: a reworded manifest description
 * changes what a marketplace listing says, not what the agent does.
 *
 * Unknown counts as changed: if a tag is missing or git refuses, a hint nobody
 * needed is cheaper than silence about one they did.
 */
async function skillChangedBetween(from: string, to: string): Promise<boolean> {
	try {
		return (await git(["diff", "--name-only", from, to, "--", ".claude-plugin/skills"])) !== "";
	} catch {
		return true;
	}
}

/**
 * The other half of the install (§7.2). `ntb update` cannot update it — that is
 * Claude Code's own state, and a plugin update needs a restart of Claude Code to
 * apply, so there is no version of this that ends with the job done. Reporting
 * is the honest ceiling, and the common case is silence: the versions match, or
 * the release never touched the skill.
 */
async function reportPlugin(claudeDir: string, cliVersion: string): Promise<void> {
	const installed = installedPluginVersion(claudeDir);
	if (installed === null) {
		log.info(
			"the Claude Code plugin is not installed — `!ntb` works, but the agent cannot start a "
				+ "review by itself. To add it, in Claude Code:",
		);
		log.info("  /plugin marketplace add korvin89/notabene");
		log.info("  /plugin install ntb@notabene");
		return;
	}
	if (compareVersions(installed, cliVersion) >= 0) return;
	if (!(await skillChangedBetween(`v${installed}`, `v${cliVersion}`))) return;

	log.info(`the plugin is at ${installed} and still ships that skill, while this CLI is ${cliVersion}.`);
	log.info("  /plugin marketplace update notabene");
	log.info("  /plugin update ntb@notabene");
	log.info("then restart Claude Code — a plugin update only applies after a restart.");
}

export async function update(options: UpdateOptions): Promise<ExitCode> {
	if (!existsSync(MARKER)) {
		throw new ReviewError(
			`${ROOT} is not a managed install (no .managed-install marker) — this looks like a `
				+ "development checkout. Update it with git yourself, or install a managed copy "
				+ "with install.sh.",
		);
	}

	log.info(`checking for updates (installed: ${installedVersion()})`);
	try {
		await git(["fetch", "--quiet", "--tags", "--prune", "origin"]);
	} catch (error) {
		throw new ReviewError(`could not reach the remote: ${error instanceof Error ? error.message : String(error)}`);
	}

	const latest = await latestTag();
	if (latest === "") {
		log.info("the remote has no release tags yet — nothing to update to.");
		return EXIT.ok;
	}

	// The plugin is reported against the CLI you HAVE, not the one on offer: until
	// `ntb update` actually runs, a newer release says nothing about the drift.
	const current = await currentTag();
	if (current === latest) {
		log.info(`already on the newest release (${latest}).`);
		await reportPlugin(options.claudeDir, installedVersion());
		return EXIT.ok;
	}

	if (options.checkOnly) {
		log.info(`a newer release is available: ${latest} (installed: ${current === "" ? installedVersion() : current})`);
		log.info("run `ntb update` to install it.");
		await reportPlugin(options.claudeDir, installedVersion());
		return EXIT.ok;
	}

	log.info(`updating to ${latest}`);
	await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", latest]);

	// package.json may have moved the pinned viewer (D20), so dependencies are
	// reinstalled on every update rather than only when the lockfile changed.
	log.info("installing dependencies (this may take a moment)");
	await execFileAsync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: NPM_TIMEOUT_MS,
	});

	log.info(`updated to ${latest} (ntb ${installedVersion()}).`);
	await reportPlugin(options.claudeDir, installedVersion());
	return EXIT.ok;
}
