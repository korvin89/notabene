// Process-tree walk for the fallback level of the session source (ARCHITECTURE.md §4.1, item 2).

import { execFileSync } from "node:child_process";

export interface ProcTable {
	/** ppid of the process, or null if the process was not found */
	parentOf(pid: number): number | null;
}

export const systemProcTable: ProcTable = {
	parentOf(pid: number): number | null {
		try {
			const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const parsed = Number.parseInt(out.trim(), 10);
			return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
		} catch {
			return null;
		}
	},
};

/**
 * Ancestor chain, starting with `pid` itself. Depth-limited: under `!` the process
 * is detached from the terminal and the tree shape is not guaranteed — must not loop.
 */
export function ancestors(proc: ProcTable, pid: number, maxDepth = 12): number[] {
	const chain: number[] = [];
	const seen = new Set<number>();
	let current: number | null = pid;
	while (current !== null && current > 1 && chain.length < maxDepth && !seen.has(current)) {
		chain.push(current);
		seen.add(current);
		current = proc.parentOf(current);
	}
	return chain;
}
