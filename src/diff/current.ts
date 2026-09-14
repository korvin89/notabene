// The "current" diff source (ARCHITECTURE.md §2): state of the working tree
// relative to HEAD — `git diff HEAD` + untracked files
// (`git ls-files -o --exclude-standard`).
//
// Everything is parsed into the src/model/diff.ts model. Outside a git repository —
// a warning on stderr and an empty changeset list: that is a valid answer, not an
// error (agreed behavior, DECISIONS.md D11).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { log } from "../io.ts";
import { reviewsDir } from "../store/index.ts";
import type { Changeset, FileChangeKind, FileDiff, Hunk, HunkLine } from "../model/diff.ts";
import type { DiffSourceOptions } from "./index.ts";

const execFileAsync = promisify(execFile);

/** Diffs can be large; the default 1 MiB maxBuffer is too small for them. */
const MAX_BUFFER = 64 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	return stdout;
}

/**
 * Root of the repository that owns `cwd`; null — not a repository or no git.
 * Silent: whoever builds the diff warns, not whoever anchors the review root
 * (`run.ts` calls this on `collect` too, where there is nothing to complain about).
 */
export async function gitToplevel(cwd: string): Promise<string | null> {
	try {
		return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return null;
	}
}

export async function currentChangesets(options: DiffSourceOptions): Promise<Changeset[]> {
	let root: string;
	try {
		root = (await git(options.cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			log.warn("git not found in PATH — current mode is unavailable, no changes.");
		} else {
			log.warn(
				`${options.cwd} is not a git repository; current mode compares the working `
					+ "tree against HEAD, nothing to show.",
			);
		}
		return [];
	}

	const base = await diffBase(root);
	const patch = await git(root, [
		// these options sterilize the user's gitconfig: prefixes override
		// diff.noprefix/mnemonicPrefix, --unified overrides diff.context, the rest is obvious
		"-c", "core.quotepath=false",
		"diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative",
		"--find-renames", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/",
		base,
	]);
	const files = parseGitPatch(patch).filter((file) => !isOwnArtifact(root, file.path));
	for (const path of await untrackedPaths(root)) {
		if (isOwnArtifact(root, path)) continue;
		const file = await untrackedFileDiff(root, path);
		if (file !== null) files.push(file);
	}
	await fillSideTexts(root, base, files);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	log.debug(`current: files with changes — ${files.length}, base — ${base}`);
	if (files.length === 0) return [];
	return [
		{
			id: "current",
			mode: "current",
			label: "Current state",
			root,
			files,
		},
	];
}

/**
 * Comparison base. Usually HEAD; in a repository without a single commit it does not
 * exist yet — then we compare against the empty tree, and everything staged honestly
 * becomes "added".
 */
async function diffBase(root: string): Promise<string> {
	try {
		await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
		return "HEAD";
	} catch {
		return (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).trim();
	}
}

async function untrackedPaths(root: string): Promise<string[]> {
	const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	return out.split("\0").filter((path) => path !== "");
}

/**
 * The review's own service files (`.claude/reviews/`) are not shown in the diff,
 * even if a foreign repository did not add them to `.gitignore`. Otherwise the
 * handoff of the previous run becomes an untracked file of the next one, its text
 * travels into the `newText` of the new handoff — which then grows roughly
 * threefold per run.
 */
function isOwnArtifact(root: string, path: string): boolean {
	const prefix = `${relative(root, reviewsDir(root))}/`;
	return path.startsWith(prefix);
}

/** null — the file disappeared between `ls-files` and reading; skip silently. */
async function untrackedFileDiff(root: string, path: string): Promise<FileDiff | null> {
	let buffer: Buffer;
	try {
		buffer = await readFile(join(root, path));
	} catch {
		return null;
	}
	if (looksBinary(buffer)) {
		return { path, changeKind: "added", binary: true, hunks: [] };
	}
	const text = buffer.toString("utf8");
	const file: FileDiff = { path, changeKind: "added", binary: false, hunks: [], newText: text };
	if (text !== "") file.hunks.push(wholeFileHunk(text));
	return file;
}

/** Git's own heuristic: a NUL in the first 8 KiB means binary. */
function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8192).includes(0);
}

/** A single "whole file added" hunk — exactly like git's `@@ -0,0 +1,N @@`. */
function wholeFileHunk(text: string): Hunk {
	const rows = text.split("\n");
	if (rows.at(-1) === "") rows.pop();
	return {
		oldStart: 0,
		oldLines: 0,
		newStart: 1,
		newLines: rows.length,
		lines: rows.map(
			(row, index): HunkLine => ({ kind: "add", oldLine: null, newLine: index + 1, text: row }),
		),
	};
}

/**
 * Full texts of both sides (FileDiff.oldText/newText) — hunk needs them for
 * `readFileSource`, and the current source gets them cheaply: the old side is a blob
 * in the base, the new one is the working copy. Not filled for binaries.
 */
async function fillSideTexts(root: string, base: string, files: FileDiff[]): Promise<void> {
	for (const file of files) {
		if (file.binary) continue;
		if (file.changeKind !== "added" && file.oldText === undefined) {
			const oldPath = file.previousPath ?? file.path;
			try {
				file.oldText = await git(root, ["cat-file", "blob", `${base}:${oldPath}`]);
			} catch {
				log.debug(`current: failed to read ${base}:${oldPath}`);
			}
		}
		if (file.changeKind !== "deleted" && file.newText === undefined) {
			try {
				file.newText = await readFile(join(root, file.path), "utf8");
			} catch {
				log.debug(`current: failed to read the working copy of ${file.path}`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Parsing the unified output of `git diff`
// ---------------------------------------------------------------------------

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

/** Exported for unit tests of markup edge cases; a pure function. */
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
