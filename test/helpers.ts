// Fixtures: a fake `~/.claude` and a fake process tree.
// No test touches the user's real directory.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitLines } from "../src/diff/text-diff.ts";
import type { Hunk } from "../src/model/diff.ts";
import { projectSlug } from "../src/session/transcript.ts";
import type { ProcTable } from "../src/session/proc.ts";

export interface ClaudeFixture {
	claudeDir: string;
	/** write `~/.claude/sessions/<pid>.json` */
	session(pid: number, body: Record<string, unknown> | string): void;
	/** write `~/.claude/projects/<slug>/<sessionId>.jsonl` */
	transcript(cwd: string, sessionId: string): string;
}

export function claudeFixture(): ClaudeFixture {
	const claudeDir = join(mkdtempSync(join(tmpdir(), "notabene-test-")), ".claude");
	mkdirSync(join(claudeDir, "sessions"), { recursive: true });
	mkdirSync(join(claudeDir, "projects"), { recursive: true });

	return {
		claudeDir,
		session(pid, body): void {
			const raw = typeof body === "string" ? body : JSON.stringify(body);
			writeFileSync(join(claudeDir, "sessions", `${pid}.json`), raw);
		},
		transcript(cwd, sessionId): string {
			const dir = join(claudeDir, "projects", projectSlug(cwd));
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${sessionId}.jsonl`);
			writeFileSync(path, "");
			return path;
		},
	};
}

/** The process tree as a pid → ppid dictionary. */
export function fakeProcTable(parents: Record<number, number>): ProcTable {
	return { parentOf: (pid) => parents[pid] ?? null };
}

/**
 * Rebuilds the new text from the old one via hunks (fails on any mismatch).
 * The main T4 invariant: applyHunks(oldText, hunks) === the new text.
 */
export function applyHunks(oldText: string, hunks: Hunk[]): string {
	const oldLines = splitLines(oldText);
	const out: string[] = [];
	let cursor = 0; // 0-based over oldLines
	for (const hunk of hunks) {
		const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
		assert.ok(start >= cursor, `hunks overlap: oldStart=${hunk.oldStart} with cursor at ${cursor}`);
		while (cursor < start) out.push(oldLines[cursor++] as string);
		for (const line of hunk.lines) {
			if (line.kind === "add") {
				out.push(line.text);
				continue;
			}
			assert.equal(oldLines[cursor], line.text, `line ${cursor + 1} of the old text did not match`);
			if (line.kind === "context") out.push(line.text);
			cursor += 1;
		}
	}
	while (cursor < oldLines.length) out.push(oldLines[cursor++] as string);
	return out.join("\n");
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
