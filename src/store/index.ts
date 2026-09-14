// Review-session storage (ARCHITECTURE.md §3.2).
//
// The default location is `<repo>/.claude/reviews/` (already gitignored); this
// is the default answer (DECISIONS.md D10). No rotation until it hurts.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ReviewError } from "../io.ts";
import type { CommentStore, ReviewDocument } from "../model/review.ts";

export function reviewsDir(cwd: string): string {
	return join(cwd, ".claude", "reviews");
}

/** Draft of the current session: links `ntb open` and `ntb collect` (flow C). */
export function pendingPath(cwd: string): string {
	return join(reviewsDir(cwd), "pending.json");
}

/** Final copy: `<reviewsDir>/2026-09-13T20-15-31.json` (the offset is not carried into the name). */
export function finalPath(cwd: string, createdAt: string): string {
	return join(reviewsDir(cwd), `${createdAt.slice(0, 19).replace(/:/g, "-")}.json`);
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

export function fileCommentStore(cwd: string): CommentStore {
	const dir = reviewsDir(cwd);
	const ensureDir = (): Promise<string | undefined> => mkdir(dir, { recursive: true });

	return {
		dir,
		async loadPending(): Promise<ReviewDocument | null> {
			const path = pendingPath(cwd);
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
			await writeFile(pendingPath(cwd), serialize(doc), "utf8");
		},
		async clearPending(): Promise<void> {
			await rm(pendingPath(cwd), { force: true });
		},
		/**
		 * Returns the path RELATIVE to cwd (the repo root) — the exact string that
		 * goes into the batch tail "Machine-readable copy: …" (ARCHITECTURE.md §3.1).
		 * Name collisions (two reviews within one second) are resolved with the
		 * `-2`, `-3`… suffix.
		 */
		async saveFinal(doc: ReviewDocument): Promise<string> {
			await ensureDir();
			let path = finalPath(cwd, doc.createdAt);
			for (let n = 2; existsSync(path); n += 1) {
				path = finalPath(cwd, doc.createdAt).replace(/\.json$/, `-${n}.json`);
			}
			await writeFile(path, serialize(doc), "utf8");
			return relative(cwd, path);
		},
	};
}
