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
 * Newest tag by version order. Empty string when the repository has no tags —
 * an unreleased remote is a normal state, not a failure.
 */
async function latestTag(): Promise<string> {
	const tags = await git(["tag", "--list", "--sort=-v:refname"]);
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

	const current = await currentTag();
	if (current === latest) {
		log.info(`already on the newest release (${latest}).`);
		return EXIT.ok;
	}

	if (options.checkOnly) {
		log.info(`a newer release is available: ${latest} (installed: ${current === "" ? installedVersion() : current})`);
		log.info("run `ntb update` to install it.");
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
	return EXIT.ok;
}
