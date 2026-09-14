// Path resolution: the platform hunk binary, the extension directory, the ntb script.
//
// Pitfall from ARCHITECTURE.md §5.3: `kitty @ launch` runs the command in
// kitty's own environment (a stripped PATH without rc files), while the npm
// shim `bin/hunk.cjs` is `#!/usr/bin/env node`, which cannot find node itself
// in such an environment. So the viewer is always invoked as the platform
// binary by absolute path; it does not need Node at all (99 MB standalone
// Mach-O, docs/spike-hunk.md).

import { accessSync, chmodSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { ReviewError, log } from "../io.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");

/** Absolute path to our CLI — for flow C hints (second terminal). */
export function ntbBinPath(): string {
	return join(PROJECT_ROOT, "ntb");
}

/**
 * How to spell our CLI in a hint the user will type in another terminal: the
 * bare `ntb` when that name on `PATH` resolves to this very wrapper, and the
 * absolute path otherwise.
 *
 * The fallback is not paranoia: a development checkout is never on `PATH`, the
 * installer's bin directory may not be either (it says so when it isn't), and
 * `ntb` on `PATH` could belong to a different install entirely. Printing a bare
 * command in those cases would hand the user a line that runs the wrong thing.
 */
export function ntbCommand(env: NodeJS.ProcessEnv): string {
	const absolute = ntbBinPath();
	const onPath = findInPath(env, "ntb");
	if (onPath === null) return absolute;
	try {
		if (realpathSync(onPath) === realpathSync(absolute)) return "ntb";
	} catch {
		// the file went away between the lookup and the resolve (a dangling
		// symlink is already filtered out by the lookup) — the path still works
	}
	return absolute;
}

/** Directory of our hunk extension — the `hunk diff --extension …` argument. */
export function extensionDir(): string {
	return join(PROJECT_ROOT, "src", "hunk-ext");
}

function platformBinary(packageRoot: string): string | null {
	const pkg = `hunkdiff-${process.platform}-${process.arch}`;
	const bin = join(packageRoot, "node_modules", pkg, "bin", process.platform === "win32" ? "hunk.exe" : "hunk");
	if (!existsSync(bin)) return null;
	// npm does not set the exec bit: both hunkdiff and the platform package
	// declare a "hunk" bin, and the collision leaves the platform one unlinked
	// (found in T5).
	try {
		accessSync(bin, constants.X_OK);
	} catch {
		try {
			chmodSync(bin, 0o755);
		} catch {
			log.warn(`hunk binary is not executable and chmod failed: ${bin}`);
			return null;
		}
	}
	return bin;
}

function findInPath(env: NodeJS.ProcessEnv, name: string): string | null {
	for (const dir of (env["PATH"] ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Order: explicit override → platform binary from our node_modules (hunkdiff
 * is pinned to an exact version in package.json) → platform binary of a global
 * install (the shim in PATH points at it) → the shim itself as a last resort
 * (fine for flow C in a live terminal, but not for kitty).
 */
export function resolveHunkBinary(env: NodeJS.ProcessEnv): string {
	const override = env["NOTABENE_HUNK"];
	if (override !== undefined && override !== "") return override;

	const local = platformBinary(PROJECT_ROOT);
	if (local !== null) return local;

	const shim = findInPath(env, "hunk");
	if (shim !== null) {
		try {
			// The npm shim is a symlink to <…>/node_modules/hunkdiff/bin/hunk.cjs;
			// the platform binary lives in node_modules of that same package.
			const real = realpathSync(shim);
			const fromShim = platformBinary(join(dirname(real), ".."));
			if (fromShim !== null) return fromShim;
		} catch {
			// broken symlink — fall back to the shim below
		}
		log.warn(
			"platform hunk binary not found — using the npm shim from PATH; "
				+ "it may fail to start in a kitty tab (run `npm install` in notabene).",
		);
		return shim;
	}

	throw new ReviewError(
		"hunk not found: run `npm install` in the notabene directory "
			+ "(the hunkdiff dependency is pinned in package.json).",
	);
}
