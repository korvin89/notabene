// Registry of live sessions: `~/.claude/sessions/<pid>.json` (ARCHITECTURE.md §4.1, item 2).
//
// A real entry (verified 2026-09-13):
// {"pid":62678,"sessionId":"7ed463a1-…","cwd":"/Users/…/notabene","startedAt":…,
//  "version":"2.1.241","kind":"interactive","status":"busy","updatedAt":…}
//
// The format is internal and may change, so we read leniently: everything except
// `sessionId` is optional, and broken JSON simply means "not our file".

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionRegistryEntry {
	pid: number;
	sessionId: string;
	cwd: string | null;
	kind: string | null;
}

export function sessionsDir(claudeDir: string): string {
	return join(claudeDir, "sessions");
}

export function readRegistryEntry(claudeDir: string, pid: number): SessionRegistryEntry | null {
	let raw: string;
	try {
		raw = readFileSync(join(sessionsDir(claudeDir), `${pid}.json`), "utf8");
	} catch {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const sessionId = record["sessionId"];
	if (typeof sessionId !== "string" || sessionId === "") return null;

	const cwd = record["cwd"];
	const kind = record["kind"];
	return {
		pid,
		sessionId,
		cwd: typeof cwd === "string" && cwd !== "" ? cwd : null,
		kind: typeof kind === "string" ? kind : null,
	};
}
