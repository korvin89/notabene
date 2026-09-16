// One-time migration of the pre-D30 state directory (ARCHITECTURE.md §3.2).
//
// Up to 0.2.x the review state lived in `<repo>/.claude/reviews/`. Moving it out
// of the tree would otherwise strand two things: an in-flight review (pending +
// handoff + mirror — the viewer may be open right now, and `collect` would answer
// "nothing to collect" while the comments sit in a file nobody reads), and the
// machine-readable copies, which are the safety net for a batch that never
// reached the agent. So the first run after the upgrade carries them over.
//
// The directory is then removed: left behind, it would sit in the user's
// `git status` forever, since the whole point of D30 is that we no longer ask
// for a `.gitignore` line.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { log } from "../io.ts";

export function legacyStateDir(root: string): string {
	return join(root, ".claude", "reviews");
}

/**
 * Files we are known to have written there. Anything else belongs to someone
 * else: it stays, and the leftover then keeps `rmdir` from removing the
 * directory — which is the intended outcome, not a failure.
 */
const OURS: readonly RegExp[] = [
	/^pending\.json$/,
	/^handoff\.json$/,
	// the mirror in every generation, plus the cancellation marker named after it
	/^notes(-.*)?\.json(\.tmp)?$/,
	// machine-readable copies: `2026-09-13T20-15-31.json`, `…-2.json` on collision
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?\.json$/,
];

/**
 * A pre-D30 handoff points at its mirror by ABSOLUTE path, into the directory we
 * have just emptied. Left as it is, `collect` would look the comments up where
 * they no longer are and deliver an empty review — the exact loss this migration
 * exists to prevent. The names are kept: the extension and `collect` both key on
 * them, and the mirror is per-review (D15).
 *
 * Only paths that pointed into the old directory are touched; anything else is
 * someone's deliberate choice and is left alone.
 */
function repointHandoff(path: string, legacy: string): void {
	let handoff: { notesPath?: string; outcomePath?: string };
	try {
		handoff = JSON.parse(readFileSync(path, "utf8")) as typeof handoff;
	} catch {
		return; // an unreadable handoff is already useless; migrating it is enough
	}
	const dir = dirname(path);
	const repoint = (value: string | undefined): string | undefined =>
		value !== undefined && dirname(value) === legacy ? join(dir, basename(value)) : value;

	const notes = repoint(handoff.notesPath);
	const outcome = repoint(handoff.outcomePath);
	if (notes === handoff.notesPath && outcome === handoff.outcomePath) return;

	if (notes !== undefined) handoff.notesPath = notes;
	if (outcome !== undefined) handoff.outcomePath = outcome;
	try {
		writeFileSync(path, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
	} catch {
		// The files are already moved; a handoff we cannot rewrite costs the
		// comments of one in-flight review, not the migration.
	}
}

/** `rename` is a move within one filesystem; `~` and the repo need not share one. */
function move(from: string, to: string): void {
	try {
		renameSync(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		copyFileSync(from, to);
		rmSync(from, { force: true });
	}
}

/**
 * Moves a legacy state directory into `stateDir`. Never throws: a review that
 * cannot be migrated is worth a warning, not a failed run — the new location is
 * empty and usable either way.
 *
 * Returns the number of files moved (0 — nothing to do).
 */
export function migrateLegacyState(root: string, stateDir: string): number {
	const legacy = legacyStateDir(root);
	if (legacy === stateDir || !existsSync(legacy)) return 0;

	let moved = 0;
	let left = 0;
	try {
		for (const name of readdirSync(legacy)) {
			if (!OURS.some((pattern) => pattern.test(name))) {
				left += 1;
				continue;
			}
			const target = join(stateDir, name);
			// Never clobber: a file already in the new location belongs to a review
			// that ran after the upgrade and is younger than whatever is here.
			if (existsSync(target)) {
				left += 1;
				continue;
			}
			mkdirSync(stateDir, { recursive: true });
			move(join(legacy, name), target);
			if (name === "handoff.json") repointHandoff(target, legacy);
			moved += 1;
		}
	} catch (error) {
		log.warn(
			`could not move the old review directory ${legacy} to ${stateDir}: `
				+ `${error instanceof Error ? error.message : String(error)}. It is left as it is.`,
		);
		return moved;
	}

	if (left === 0) {
		// Both calls fail while anything is left inside — which is the point. The
		// `.claude` above it goes only when we are the ones who created it, i.e.
		// when it is now empty; Claude Code's own settings there keep it.
		try {
			rmdirSync(legacy);
			rmdirSync(dirname(legacy));
		} catch {
			// nothing: a directory git does not track is not worth a word
		}
	}
	if (moved > 0) {
		log.info(`moved ${moved} review file(s) out of ${legacy} into ${stateDir} — reviews no longer live in the repository.`);
	}
	return moved;
}
