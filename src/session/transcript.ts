// Locating the session's JSONL transcript — the input for the per-turn source (T4).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Claude Code stores transcripts in `~/.claude/projects/<slug>/<session-id>.jsonl`,
 * where slug is the project path with every non-alphanumeric character replaced by
 * a hyphen (`/Users/x/pet-projects/notabene` → `-Users-x-pet-projects-notabene`).
 */
export function projectSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectsDir(claudeDir: string): string {
	return join(claudeDir, "projects");
}

/**
 * First the direct path via the slug, then a scan of the project directories.
 * The scan is needed because the slug rule is undocumented and may change,
 * and also because `review` may have been launched from a subdirectory of the repo.
 */
export function findTranscript(
	claudeDir: string,
	cwd: string,
	sessionId: string,
): string | null {
	const file = `${sessionId}.jsonl`;
	const direct = join(projectsDir(claudeDir), projectSlug(cwd), file);
	if (existsSync(direct)) return direct;

	let entries: string[];
	try {
		entries = readdirSync(projectsDir(claudeDir), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return null;
	}

	for (const dir of entries) {
		const candidate = join(projectsDir(claudeDir), dir, file);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}
