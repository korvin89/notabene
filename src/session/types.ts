// Session source (ARCHITECTURE.md §2, §4.1).

import type { ProcTable } from "./proc.ts";

export type SessionOrigin = "env" | "pid";

export interface SessionInfo {
	sessionId: string;
	/** working directory of the session; the review root is derived from it (D14) */
	cwd: string;
	/** pid of the `claude` process, if known (needed for diagnostics and flow A) */
	claudePid: number | null;
	/** which reliability level produced the result — visible in `dump session` */
	origin: SessionOrigin;
}

/** Everything a source takes from the outside world. Extracted so tests can hit fixtures. */
export interface SessionContext {
	env: NodeJS.ProcessEnv;
	/** Claude Code state directory (usually `~/.claude`) */
	claudeDir: string;
	/** cwd of the `review` process */
	cwd: string;
	/** pid of the `review` process — the process-tree walk starts from it */
	pid: number;
	proc: ProcTable;
}

export interface SessionSource {
	readonly name: SessionOrigin;
	/** null — this level did not produce a result, try the next one */
	resolve(ctx: SessionContext): SessionInfo | null;
}
