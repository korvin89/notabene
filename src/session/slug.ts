// Claude Code's project slug.
//
// It used to be the transcript locator's helper — the per-turn source needed
// `~/.claude/projects/<slug>/<session-id>.jsonl` (D31 removed both). What
// survives is the naming rule itself, because our state directory borrows it:
// `<claudeDir>/notabene/<slug>/` (ARCHITECTURE.md §3.2).

/**
 * The project path with every non-alphanumeric character replaced by a hyphen
 * (`/Users/x/pet-projects/notabene` → `-Users-x-pet-projects-notabene`).
 */
export function projectSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
