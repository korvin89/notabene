// Resolving the current session — two reliability levels (ARCHITECTURE.md §4.1).
//
// 1. env: `CLAUDE_CODE_SESSION_ID` reaches both the Bash tool and `!`-commands
//    (verified by probe T1a, docs/spike-tty.md).
// 2. pid chain: walk up the ancestors to the `claude` process and read
//    `~/.claude/sessions/<pid>.json`. This correctly distinguishes parallel sessions
//    in the same repository — each has its own pid.
//
// The third level (a SessionStart hook) is not needed for the MVP and stays in reserve.

import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ReviewError } from "../io.ts";
import { ancestors, systemProcTable } from "./proc.ts";
import { readRegistryEntry } from "./registry.ts";
import type { SessionContext, SessionInfo, SessionSource } from "./types.ts";

export type { SessionContext, SessionInfo, SessionSource } from "./types.ts";
export { projectSlug } from "./slug.ts";

function parsePid(value: string | undefined): number | null {
	if (value === undefined) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const envSessionSource: SessionSource = {
	name: "env",
	resolve(ctx: SessionContext): SessionInfo | null {
		const sessionId = ctx.env["CLAUDE_CODE_SESSION_ID"];
		if (sessionId === undefined || sessionId === "") return null;

		// Take cwd from the registry if it describes the same session: `ntb` may have
		// been launched from a subdirectory (`!cd src && ntb`), while the review root
		// is the repository top (D14).
		const claudePid = parsePid(ctx.env["CLAUDE_PID"]);
		const entry = claudePid === null ? null : readRegistryEntry(ctx.claudeDir, claudePid);
		const cwd = entry !== null && entry.sessionId === sessionId && entry.cwd !== null
			? entry.cwd
			: ctx.cwd;

		return { sessionId, cwd, claudePid, origin: "env" };
	},
};

export const pidSessionSource: SessionSource = {
	name: "pid",
	resolve(ctx: SessionContext): SessionInfo | null {
		for (const pid of ancestors(ctx.proc, ctx.pid)) {
			const entry = readRegistryEntry(ctx.claudeDir, pid);
			if (entry === null) continue;
			return {
				sessionId: entry.sessionId,
				cwd: entry.cwd ?? ctx.cwd,
				claudePid: entry.pid,
				origin: "pid",
			};
		}
		return null;
	},
};

export const sessionSources: readonly SessionSource[] = [envSessionSource, pidSessionSource];

/**
 * Claude Code's state directory. Ours is keyed off it too (§3.2), and `ntb
 * update` needs it without resolving a session at all — hence a function rather
 * than an expression inlined into the context builder.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

export function defaultSessionContext(
	overrides: Partial<SessionContext> = {},
): SessionContext {
	const env = overrides.env ?? process.env;
	const claudeDir = overrides.claudeDir ?? claudeConfigDir(env);
	return {
		env,
		claudeDir,
		cwd: overrides.cwd ?? process.cwd(),
		pid: overrides.pid ?? process.pid,
		proc: overrides.proc ?? systemProcTable,
	};
}

/** The first level that fires wins. */
export function resolveSession(ctx: SessionContext = defaultSessionContext()): SessionInfo {
	for (const source of sessionSources) {
		const info = source.resolve(ctx);
		if (info !== null) return info;
	}
	throw new ReviewError(
		"could not determine the Claude Code session: CLAUDE_CODE_SESSION_ID is not set and "
			+ `no process ancestor is a claude with an entry in ${join(ctx.claudeDir, "sessions")}. `
			+ "Run it from inside a session — `/ntb`.",
	);
}
