// Review delivery (ARCHITECTURE.md §2, §3.1).
//
// There is a single delivery — the batch to stdout. A second one (into the
// agent's pane via the Herdr socket API) was planned and dropped together with
// post-MVP (DECISIONS.md D21); the interface still fits a second implementation
// if that decision is ever revisited.
//
// Batch format — §3.1: a header with the mode/turn and instructions for the
// agent, items `@path:start-end [type]` with the comment body, WITHOUT retelling
// the diff, and the path to the machine-readable copy at the tail. For the old
// side the reference keeps the same line number as the anchor (delivery cannot
// remap it to the nearest surviving line on the new side: per the T2 contract it
// only has the review model, no diff), while the side and the exact anchor stay
// in parentheses and in the JSON — exactly as in the §3.1 example
// (`@src/balance.md:10 … (deleted line, old:10)`).

import { emit, log } from "../io.ts";
import type { ReviewComment, ReviewDocument, ReviewSource } from "../model/review.ts";

export interface DeliveryContext {
	/** path to the machine-readable copy; printed at the tail of the batch */
	jsonPath: string | null;
	/** whether to add context lines to items (§3.1, behind the flag) */
	includeContext: boolean;
}

export interface Delivery {
	readonly name: string;
	deliver(review: ReviewDocument, ctx: DeliveryContext): Promise<void>;
}

/**
 * Soft ceiling for the batch (ARCHITECTURE.md §3.1): the inline `!`-output limit
 * is ~30k characters, we stay below it with a margin. Approaching the ceiling
 * trims context lines — but NEVER the comments themselves.
 */
export const STDOUT_LIMIT = 25_000;

/** No more than three context lines per item (§3.1: "1–3 lines"). */
const MAX_CONTEXT_LINES = 3;

/** Item body indent — aligned under the number, as in the §3.1 example. */
const INDENT = "   ";

/** The header stays a single line: the prompt snippet is guarded against walls of text. */
const SNIPPET_MAX = 80;

export interface FormattedBatch {
	text: string;
	/** how many items had their context trimmed by the limit (comments always survive) */
	contextDropped: number;
}

function countComments(count: number): string {
	return count === 1 ? "1 comment" : `${count} comments`;
}

function flatSnippet(raw: string): string {
	const flat = raw.replace(/\s+/g, " ").trim();
	return flat.length <= SNIPPET_MAX ? flat : `${flat.slice(0, SNIPPET_MAX - 1)}…`;
}

function headerBlock(source: ReviewSource, count: number): string[] {
	const subject = source.mode === "turn"
		? `the turn T${source.turn ?? "?"} diff${
			source.promptSnippet === null || source.promptSnippet === ""
				? ""
				: ` ("${flatSnippet(source.promptSnippet)}")`
		}`
		: "the current state diff";
	return [
		`Review of ${subject}, ${countComments(count)}.`,
		"Address each item; make the edits, then briefly summarize: what you changed,",
		"what you skipped and why. If an item is unclear, ask a clarifying question about it.",
	];
}

function lineRef(comment: ReviewComment): string {
	return comment.startLine === comment.endLine
		? `${comment.startLine}`
		: `${comment.startLine}-${comment.endLine}`;
}

/** The exact old-side anchor goes in parentheses; the reference stays clickable on the new side. */
function oldSideNote(comment: ReviewComment): string {
	if (comment.side !== "old") return "";
	const what = comment.startLine === comment.endLine ? "deleted line" : "deleted lines";
	return ` (${what}, old:${lineRef(comment)})`;
}

function itemBlock(index: number, comment: ReviewComment): string[] {
	const head = `${index}. @${comment.file}:${lineRef(comment)} [${comment.type}]${oldSideNote(comment)}`;
	const body = comment.body.split("\n").map((line) => `${INDENT}${line}`.trimEnd());
	return [head, ...body];
}

function contextLines(comment: ReviewComment): string[] {
	return comment.context
		.slice(0, MAX_CONTEXT_LINES)
		.map((line) => `${INDENT}> ${line}`.trimEnd());
}

/**
 * Pure function: review model → batch text. An empty review yields an empty
 * string (stdout stays empty, Claude stays silent — a spec requirement).
 */
export function formatReviewBatch(review: ReviewDocument, ctx: DeliveryContext): FormattedBatch {
	if (review.comments.length === 0) return { text: "", contextDropped: 0 };

	const header = headerBlock(review.source, review.comments.length);
	const items = review.comments.map((comment, index) => itemBlock(index + 1, comment));
	const tail: string[][] = ctx.jsonPath === null ? [] : [[`Machine-readable copy: ${ctx.jsonPath}`]];

	const assemble = (): string =>
		`${[header, ...items, ...tail].map((block) => block.join("\n")).join("\n\n")}\n`;

	// Context is added greedily in item order while the batch fits the ceiling:
	// on overflow only the context lines of trailing items are sacrificed.
	let contextDropped = 0;
	if (ctx.includeContext) {
		let total = assemble().length;
		review.comments.forEach((comment, index) => {
			const lines = contextLines(comment);
			const item = items[index];
			if (lines.length === 0 || item === undefined) return;
			const added = lines.reduce((sum, line) => sum + line.length + 1, 0);
			if (total + added <= STDOUT_LIMIT) {
				item.push(...lines);
				total += added;
			} else {
				contextDropped += 1;
			}
		});
	}

	return { text: assemble(), contextDropped };
}

/** T6: header + items `@path:start-end [type]`, no diff retelling, ~25k limit. */
export function stdoutDelivery(): Delivery {
	return {
		name: "stdout",
		async deliver(review: ReviewDocument, ctx: DeliveryContext): Promise<void> {
			const batch = formatReviewBatch(review, ctx);
			if (batch.contextDropped > 0) {
				log.debug(
					`stdout limit ~${STDOUT_LIMIT} chars: context trimmed on ${batch.contextDropped} item(s)`,
				);
			}
			if (batch.text.length > STDOUT_LIMIT) {
				log.warn(
					`the batch exceeds ~${STDOUT_LIMIT} chars even without context — comments are never trimmed, `
						+ "but the tail may end up in the background-task file.",
				);
			}
			emit(batch.text);
		},
	};
}
