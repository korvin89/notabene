// Fixtures: a fake `~/.claude` and a fake process tree.
// No test touches the user's real directory.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcTable } from "../src/session/proc.ts";

export interface ClaudeFixture {
	claudeDir: string;
	/** write `~/.claude/sessions/<pid>.json` */
	session(pid: number, body: Record<string, unknown> | string): void;
}

export function claudeFixture(): ClaudeFixture {
	const claudeDir = join(mkdtempSync(join(tmpdir(), "notabene-test-")), ".claude");
	mkdirSync(join(claudeDir, "sessions"), { recursive: true });

	return {
		claudeDir,
		session(pid, body): void {
			const raw = typeof body === "string" ? body : JSON.stringify(body);
			writeFileSync(join(claudeDir, "sessions", `${pid}.json`), raw);
		},
	};
}

/** The process tree as a pid → ppid dictionary. */
export function fakeProcTable(parents: Record<number, number>): ProcTable {
	return { parentOf: (pid) => parents[pid] ?? null };
}

/** Captures stderr for the duration of the call — to check log.warn warnings. */
export async function captureStderr(run: () => Promise<void> | void): Promise<string> {
	const original = process.stderr.write.bind(process.stderr);
	let buffer = "";
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		await run();
	} finally {
		process.stderr.write = original;
	}
	return buffer;
}
