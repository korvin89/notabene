// Line-based diff of two texts → the model's Hunk[] (T4).
//
// No dependencies (project rule), so the diff is our own: LCS via dynamic
// programming with common prefix/suffix trimming. For version pairs from
// file-history this is enough — they are adjacent snapshots of one file, edits
// are local. On pathologically large dissimilar pairs (see CELL_CAP) we do not
// promise honest minimality and emit a single replace hunk — a correct diff,
// just not the shortest one.

import type { Hunk, HunkLine } from "../model/diff.ts";

/** The standard three lines of context around changes, as in unified diff. */
const CONTEXT = 3;

/**
 * Cap on the DP table (in cells). 4M cells is, for example, a pair of versions
 * of ~2000 mismatching lines each; above that it is almost certainly "the file
 * was rewritten entirely".
 */
const CELL_CAP = 4_000_000;

interface Op {
	kind: "same" | "del" | "add";
	text: string;
}

/**
 * Text → lines. A trailing newline does not produce a phantom empty line,
 * and empty text (including "no file") is zero lines, not one empty line.
 */
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Diff of two full texts. An empty string is interpreted as "no file" by the
 * caller — here it is simply a text of zero lines.
 */
export function diffTexts(oldText: string, newText: string): Hunk[] {
	if (oldText === newText) return [];
	return buildHunks(diffOps(splitLines(oldText), splitLines(newText)));
}

function diffOps(oldLines: string[], newLines: string[]): Op[] {
	// The common prefix and suffix stay outside the DP table.
	let prefix = 0;
	const max = Math.min(oldLines.length, newLines.length);
	while (prefix < max && oldLines[prefix] === newLines[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < max - prefix
		&& oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
	const newMid = newLines.slice(prefix, newLines.length - suffix);

	const ops: Op[] = [];
	for (let i = 0; i < prefix; i += 1) ops.push({ kind: "same", text: oldLines[i] as string });
	ops.push(...middleOps(oldMid, newMid));
	for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
		ops.push({ kind: "same", text: oldLines[i] as string });
	}
	return ops;
}

function middleOps(oldMid: string[], newMid: string[]): Op[] {
	const n = oldMid.length;
	const m = newMid.length;
	if (n === 0 && m === 0) return [];
	if (n === 0) return newMid.map((text) => ({ kind: "add" as const, text }));
	if (m === 0) return oldMid.map((text) => ({ kind: "del" as const, text }));
	if ((n + 1) * (m + 1) > CELL_CAP) {
		// Too dissimilar texts: skip the honest minimal diff — replace.
		return [
			...oldMid.map((text) => ({ kind: "del" as const, text })),
			...newMid.map((text) => ({ kind: "add" as const, text })),
		];
	}

	// The classic LCS length table + path reconstruction.
	const width = m + 1;
	const table = new Int32Array((n + 1) * width);
	for (let i = 1; i <= n; i += 1) {
		for (let j = 1; j <= m; j += 1) {
			table[i * width + j] = oldMid[i - 1] === newMid[j - 1]
				? (table[(i - 1) * width + (j - 1)] as number) + 1
				: Math.max(table[(i - 1) * width + j] as number, table[i * width + (j - 1)] as number);
		}
	}

	const reversed: Op[] = [];
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldMid[i - 1] === newMid[j - 1]) {
			reversed.push({ kind: "same", text: oldMid[i - 1] as string });
			i -= 1;
			j -= 1;
		} else if (j > 0 && (i === 0 || (table[i * width + (j - 1)] as number) >= (table[(i - 1) * width + j] as number))) {
			reversed.push({ kind: "add", text: newMid[j - 1] as string });
			j -= 1;
		} else {
			reversed.push({ kind: "del", text: oldMid[i - 1] as string });
			i -= 1;
		}
	}
	return reversed.reverse();
}

function buildHunks(ops: Op[]): Hunk[] {
	// Indices of change operations; groups further apart than 2*CONTEXT — separate hunks.
	const changed: number[] = [];
	for (let i = 0; i < ops.length; i += 1) {
		if ((ops[i] as Op).kind !== "same") changed.push(i);
	}
	if (changed.length === 0) return [];

	interface Range {
		from: number;
		to: number;
	}
	const ranges: Range[] = [];
	for (const index of changed) {
		const last = ranges[ranges.length - 1];
		if (last !== undefined && index - last.to <= CONTEXT * 2 + 1) last.to = index;
		else ranges.push({ from: index, to: index });
	}

	// Line numbers for every ops position are computed in a single pass.
	const oldAt = new Int32Array(ops.length);
	const newAt = new Int32Array(ops.length);
	let oldLine = 1;
	let newLine = 1;
	for (let i = 0; i < ops.length; i += 1) {
		oldAt[i] = oldLine;
		newAt[i] = newLine;
		const kind = (ops[i] as Op).kind;
		if (kind !== "add") oldLine += 1;
		if (kind !== "del") newLine += 1;
	}

	const hunks: Hunk[] = [];
	for (const range of ranges) {
		const from = Math.max(0, range.from - CONTEXT);
		const to = Math.min(ops.length - 1, range.to + CONTEXT);
		const lines: HunkLine[] = [];
		let oldCount = 0;
		let newCount = 0;
		for (let i = from; i <= to; i += 1) {
			const op = ops[i] as Op;
			if (op.kind === "same") {
				lines.push({ kind: "context", oldLine: oldAt[i] as number, newLine: newAt[i] as number, text: op.text });
				oldCount += 1;
				newCount += 1;
			} else if (op.kind === "del") {
				lines.push({ kind: "del", oldLine: oldAt[i] as number, newLine: null, text: op.text });
				oldCount += 1;
			} else {
				lines.push({ kind: "add", oldLine: null, newLine: newAt[i] as number, text: op.text });
				newCount += 1;
			}
		}
		hunks.push({
			// An empty hunk side is addressed with zero, as in unified diff (`@@ -0,0 +1,N @@`).
			oldStart: oldCount === 0 ? (oldAt[from] as number) - 1 : (oldAt[from] as number),
			oldLines: oldCount,
			newStart: newCount === 0 ? (newAt[from] as number) - 1 : (newAt[from] as number),
			newLines: newCount,
			lines,
		});
	}
	return hunks;
}
