// Diff sources (ARCHITECTURE.md §2). Implementations are current and turns;
// this file pins the names, options and the assembly point.

import type { Changeset, DiffSource } from "../model/diff.ts";
import type { SessionInfo } from "../session/types.ts";
import { currentChangesets } from "./current.ts";
import { turnsDiffSourceImpl } from "./turns.ts";

export interface DiffSourceOptions {
	/** root against which paths in the changeset are computed */
	cwd: string;
	session: SessionInfo;
	/** Claude Code state directory — it contains `file-history/<session-id>/` */
	claudeDir: string;
}

export { gitToplevel } from "./current.ts";

export const DIFF_SOURCE_NAMES = ["current", "turns"] as const;

export type DiffSourceName = (typeof DIFF_SOURCE_NAMES)[number];

/** T3: `git diff HEAD` + untracked (`git ls-files -o --exclude-standard`). */
export function currentDiffSource(options: DiffSourceOptions): DiffSource {
	return {
		name: "current",
		changesets: (): Promise<Changeset[]> => currentChangesets(options),
	};
}

/**
 * T4: version pairs from `~/.claude/file-history/<session-id>/` split at turn
 * boundaries (ARCHITECTURE.md §4.3). On an unfamiliar schema — degradation to
 * `fallback` (current by default) with a message on stderr. Implementation —
 * `./turns.ts`.
 */
export function turnsDiffSource(options: DiffSourceOptions, fallback?: DiffSource): DiffSource {
	return turnsDiffSourceImpl(options, fallback ?? currentDiffSource(options));
}

export function createDiffSource(name: DiffSourceName, options: DiffSourceOptions): DiffSource {
	return name === "current" ? currentDiffSource(options) : turnsDiffSource(options);
}

export function isDiffSourceName(value: string): value is DiffSourceName {
	return (DIFF_SOURCE_NAMES as readonly string[]).includes(value);
}
