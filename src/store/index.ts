// Review-session storage (ARCHITECTURE.md §3.2).
//
// The state lives OUTSIDE the reviewed repository: `<claudeDir>/notabene/<slug>/`,
// where the slug is Claude Code's own project slug for the review root
// (DECISIONS.md D30). Every function below therefore takes the resolved state
// directory, not the repository root — the two used to be the same string and
// conflating them is exactly what put megabytes of handoff into the user's tree.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReviewError } from "../io.ts";
import { projectSlug } from "../session/slug.ts";
import type { CommentStore, ReviewDocument } from "../model/review.ts";

/**
 * Where this repository's review state lives. Keyed by the review root, so a
 * session started in a subdirectory and one started at the top share it (D14),
 * and `ntb open` in a second terminal — which has no session — finds it from the
 * root alone.
 */
export function reviewStateDir(root: string, claudeDir: string): string {
	return join(claudeDir, "notabene", projectSlug(root));
}

/** Draft of the current session: links `ntb open` and `ntb collect` (flow C). */
export function pendingPath(dir: string): string {
	return join(dir, "pending.json");
}

/** Final copy: `<stateDir>/2026-09-13T20-15-31.json` (the offset is not carried into the name). */
export function finalPath(dir: string, createdAt: string): string {
	return join(dir, `${createdAt.slice(0, 19).replace(/:/g, "-")}.json`);
}

/** The on-disk schema is a contract with the outside world, so reads validate it. */
function parseReviewDocument(raw: string, path: string): ReviewDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ReviewError(
			`the pending document is corrupted (${path}): ${error instanceof Error ? error.message : String(error)}. `
				+ "Delete the file and start the review over.",
		);
	}
	const doc = parsed as Partial<ReviewDocument> | null;
	if (
		typeof doc !== "object"
		|| doc === null
		|| doc.version !== 1
		|| typeof doc.source !== "object"
		|| doc.source === null
		|| !Array.isArray(doc.comments)
	) {
		throw new ReviewError(
			`the pending document does not look like a review (${path}). Delete the file and start the review over.`,
		);
	}
	return doc as ReviewDocument;
}

function serialize(doc: ReviewDocument): string {
	return `${JSON.stringify(doc, null, 2)}\n`;
}

export function fileCommentStore(dir: string): CommentStore {
	const ensureDir = (): Promise<string | undefined> => mkdir(dir, { recursive: true });

	return {
		dir,
		async loadPending(): Promise<ReviewDocument | null> {
			const path = pendingPath(dir);
			let raw: string;
			try {
				raw = await readFile(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
			return parseReviewDocument(raw, path);
		},
		async savePending(doc: ReviewDocument): Promise<void> {
			await ensureDir();
			await writeFile(pendingPath(dir), serialize(doc), "utf8");
		},
		async clearPending(): Promise<void> {
			await rm(pendingPath(dir), { force: true });
		},
		/**
		 * Returns an ABSOLUTE path — the exact string that goes into the batch tail
		 * "Machine-readable copy: …" (ARCHITECTURE.md §3.1). It used to be relative
		 * to the repository root, which stopped meaning anything once the copies
		 * left the tree. Name collisions (two reviews within one second) are
		 * resolved with the `-2`, `-3`… suffix.
		 */
		async saveFinal(doc: ReviewDocument): Promise<string> {
			await ensureDir();
			let path = finalPath(dir, doc.createdAt);
			for (let n = 2; existsSync(path); n += 1) {
				path = finalPath(dir, doc.createdAt).replace(/\.json$/, `-${n}.json`);
			}
			await writeFile(path, serialize(doc), "utf8");
			return path;
		},
	};
}
