// Parsing the unified output of `git diff` into the src/model/diff.ts model.
//
// A pure function with no git and no filesystem: every scope (ARCHITECTURE.md
// §4.2) produces a patch the same way and hands it here. Split out of the scope
// builder because the edge cases it handles — C-quoted paths, renames, binaries,
// mode-only changes — are the part worth reading and testing on its own.

import type { FileChangeKind, FileDiff, Hunk, HunkLine } from "../model/diff.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

interface DraftFile {
	/** the `diff --git a/… b/…` line — fallback source of paths */
	headerLine: string;
	oldPath: string | null;
	newPath: string | null;
	kind: FileChangeKind | null;
	binary: boolean;
	hunks: Hunk[];
}

export function parseGitPatch(patch: string): FileDiff[] {
	const files: FileDiff[] = [];
	let draft: DraftFile | null = null;
	let hunk: Hunk | null = null;
	let oldNo = 0;
	let newNo = 0;
	let oldLeft = 0;
	let newLeft = 0;

	const flush = (): void => {
		if (draft !== null) files.push(finishFile(draft));
		draft = null;
		hunk = null;
	};

	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			flush();
			draft = { headerLine: line, oldPath: null, newPath: null, kind: null, binary: false, hunks: [] };
			continue;
		}
		if (draft === null) continue;

		if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
			// The hunk body is read strictly by the counters from the `@@` header, so
			// content starting with `---`/`+++` cannot be confused with headers.
			if (line.startsWith("\\")) continue; // "\ No newline at end of file"
			// An empty line is a zero-length context line
			// (git with diff.suppressBlankEmpty prints it without the leading space).
			const text = line === "" ? "" : line.slice(1);
			if (line.startsWith("+")) {
				newLeft -= 1;
				hunk.lines.push({ kind: "add", oldLine: null, newLine: newNo, text });
				newNo += 1;
			} else if (line.startsWith("-")) {
				oldLeft -= 1;
				hunk.lines.push({ kind: "del", oldLine: oldNo, newLine: null, text });
				oldNo += 1;
			} else {
				oldLeft -= 1;
				newLeft -= 1;
				hunk.lines.push({ kind: "context", oldLine: oldNo, newLine: newNo, text });
				oldNo += 1;
				newNo += 1;
			}
			continue;
		}
		hunk = null;

		const header = HUNK_HEADER.exec(line);
		if (header !== null) {
			const oldStart = Number.parseInt(header[1] ?? "0", 10);
			const oldLines = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
			const newStart = Number.parseInt(header[3] ?? "0", 10);
			const newLines = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
			hunk = { oldStart, oldLines, newStart, newLines, lines: [] };
			const heading = header[5];
			if (heading !== undefined && heading !== "") hunk.heading = heading;
			draft.hunks.push(hunk);
			oldNo = oldStart;
			newNo = newStart;
			oldLeft = oldLines;
			newLeft = newLines;
			continue;
		}

		if (line.startsWith("new file mode")) draft.kind = "added";
		else if (line.startsWith("deleted file mode")) draft.kind = "deleted";
		else if (line.startsWith("rename from ")) {
			draft.kind = "renamed";
			draft.oldPath = unquotePath(line.slice("rename from ".length));
		} else if (line.startsWith("rename to ")) {
			draft.kind = "renamed";
			draft.newPath = unquotePath(line.slice("rename to ".length));
		} else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			draft.binary = true;
		} else if (line.startsWith("--- ")) {
			draft.oldPath ??= sidePath(line.slice(4), "a/");
		} else if (line.startsWith("+++ ")) {
			draft.newPath ??= sidePath(line.slice(4), "b/");
		}
		// index/old mode/new mode/similarity index — the model does not need them
	}
	flush();
	return files;
}

function finishFile(draft: DraftFile): FileDiff {
	let { oldPath, newPath } = draft;
	if (oldPath === null && newPath === null) {
		// binaries and mode-only changes have neither `---/+++` nor rename headers
		({ oldPath, newPath } = pathsFromHeaderLine(draft.headerLine));
	}
	const kind = draft.kind ?? "modified";
	const path = (kind === "deleted" ? oldPath : newPath) ?? oldPath ?? newPath ?? "";
	const file: FileDiff = { path, changeKind: kind, binary: draft.binary, hunks: draft.hunks };
	if (kind === "renamed" && oldPath !== null && oldPath !== path) file.previousPath = oldPath;
	return file;
}

/** Path from `--- a/…` / `+++ b/…`; `/dev/null` — the side does not exist. */
function sidePath(raw: string, prefix: "a/" | "b/"): string | null {
	const path = unquotePath(raw);
	if (path === "/dev/null") return null;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Fallback parsing of `diff --git a/X b/Y`. Without quotes a path with a space is
 * ambiguous, but only non-renames end up here (binaries, mode-only), whose sides
 * are equal — look for the symmetric cut point "a/X b/X".
 */
function pathsFromHeaderLine(headerLine: string): { oldPath: string | null; newPath: string | null } {
	const rest = headerLine.slice("diff --git ".length);
	if (rest.startsWith('"')) {
		const [first, remainder] = takeQuoted(rest);
		if (first !== null) {
			const second = unquotePath(remainder.trimStart());
			return { oldPath: dropPrefix(first, "a/"), newPath: dropPrefix(second, "b/") };
		}
	}
	for (let i = rest.indexOf(" b/"); i !== -1; i = rest.indexOf(" b/", i + 1)) {
		const left = rest.slice(0, i);
		const right = rest.slice(i + 1);
		if (left.startsWith("a/") && left.slice(2) === right.slice(2)) {
			return { oldPath: left.slice(2), newPath: right.slice(2) };
		}
	}
	const split = rest.lastIndexOf(" b/");
	if (split !== -1 && rest.startsWith("a/")) {
		return { oldPath: rest.slice(2, split), newPath: rest.slice(split + 3) };
	}
	return { oldPath: null, newPath: null };
}

/** Cuts off a leading C-quoted string: `"a/x" b/y` → [`a/x`, ` b/y`]. */
function takeQuoted(raw: string): [string | null, string] {
	for (let i = 1; i < raw.length; i += 1) {
		if (raw[i] === "\\") {
			i += 1;
			continue;
		}
		if (raw[i] === '"') return [unquotePath(raw.slice(0, i + 1)), raw.slice(i + 1)];
	}
	return [null, raw];
}

function dropPrefix(path: string, prefix: "a/" | "b/"): string {
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Removes git's C-style quoting (`core.quotepath`): `"a/\"x\".txt"` → `a/"x".txt`.
 * With `core.quotepath=false` octal escapes remain only for control characters,
 * so we do not reassemble UTF-8 bytes from `\NNN`.
 */
function unquotePath(raw: string): string {
	if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
	let out = "";
	for (let i = 1; i < raw.length - 1; i += 1) {
		const ch = raw[i] as string;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		i += 1;
		const esc = raw[i];
		if (esc === undefined) break;
		if (esc === "n") out += "\n";
		else if (esc === "t") out += "\t";
		else if (esc === "r") out += "\r";
		else if (esc >= "0" && esc <= "7") {
			let digits = esc;
			while (digits.length < 3) {
				const next = raw[i + 1];
				if (next === undefined || next < "0" || next > "7") break;
				digits += next;
				i += 1;
			}
			out += String.fromCharCode(Number.parseInt(digits, 8));
		} else out += esc;
	}
	return out;
}
