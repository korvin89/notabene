// What Claude Code records about our plugin (ARCHITECTURE.md §7.2).
//
// The plugin is the second delivery channel and it updates by its own path
// (`/plugin update` against `ntb update`), so the two halves drift. `ntb update`
// is the one moment where that drift is both visible and cheap to report, and
// this module is what makes it visible: Claude Code writes its own installation
// record, and we read it.
//
// `<claudeDir>/plugins/installed_plugins.json` is an internal format, not
// officially documented — the same class as the session registry (§4.1), and it
// gets the same rule: anything unfamiliar means "unknown", never an error. An
// update must not fail because a state file we do not own changed shape.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `plugin@marketplace`, the key Claude Code files our entry under. */
export const PLUGIN_ID = "ntb@notabene";

/** One installation of a plugin; Claude Code records one per scope. */
interface InstalledEntry {
	version?: unknown;
}

/**
 * Version of our plugin as Claude Code has it, or null — not installed, or the
 * record is missing/unreadable/unfamiliar. Several scopes (user, project, local)
 * can hold the same plugin, so the newest wins: that is the one whose skill the
 * agent is most likely to be following.
 */
export function installedPluginVersion(claudeDir: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8"));
	} catch {
		return null;
	}
	const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
	if (typeof plugins !== "object" || plugins === null) return null;
	const entries = (plugins as Record<string, unknown>)[PLUGIN_ID];
	if (!Array.isArray(entries)) return null;

	let newest: string | null = null;
	for (const entry of entries as InstalledEntry[]) {
		const version = entry?.version;
		if (typeof version !== "string" || version === "") continue;
		if (newest === null || compareVersions(version, newest) > 0) newest = version;
	}
	return newest;
}

/**
 * Compare `X.Y.Z` strings: negative if `a` is older. Enough for our own
 * versions, which are plain SemVer with no pre-release part by decision (§7.1) —
 * a full parser would be a dependency we do not need. Non-numeric parts count
 * as 0, which keeps a malformed version from ever looking newer.
 */
export function compareVersions(a: string, b: string): number {
	const left = a.split(".");
	const right = b.split(".");
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const x = Number.parseInt(left[i] ?? "0", 10);
		const y = Number.parseInt(right[i] ?? "0", 10);
		const diff = (Number.isInteger(x) ? x : 0) - (Number.isInteger(y) ? y : 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
