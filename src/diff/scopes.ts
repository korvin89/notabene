// Review scopes (ARCHITECTURE.md §4.2) — which git comparison the review shows.
//
//   worktree   git diff HEAD              + untracked   the default
//   staged     git diff --cached HEAD                   only when the index differs
//   since REF  git diff <merge-base>      + untracked   everything this branch added
//   range A B  git diff A B                             two revisions, nothing uncommitted
//
// One run builds every scope that applies and hands them all to the viewer, so
// the human can switch without relaunching. That matters because of who starts
// the review: with `/ntb:review` it is the agent, and command-line arguments are not the
// human's to pass (ARCHITECTURE.md §5.6).
//
// Everything is parsed into the src/model/diff.ts model by ./parse.ts. Outside a
// git repository — a warning on stderr and an empty list: that is a valid answer,
// not an error (DECISIONS.md D11).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { EXIT, ReviewError, log } from "../io.ts";
import { reviewStateDir } from "../store/index.ts";
import type { Changeset, FileDiff, Hunk, HunkLine, ScopeId } from "../model/diff.ts";
import { parseGitPatch } from "./parse.ts";

const execFileAsync = promisify(execFile);

/** Diffs can be large; the default 1 MiB maxBuffer is too small for them. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * These options sterilize the user's gitconfig: the prefixes override
 * diff.noprefix/mnemonicPrefix, --unified overrides diff.context, the rest is obvious.
 */
const DIFF_ARGS = [
	"-c", "core.quotepath=false",
	"diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative",
	"--find-renames", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/",
];

/** What the command line asked for; there is at most one explicit scope per run. */
export type ScopeRequest =
	| { id: "worktree" }
	| { id: "staged" }
	| { id: "since"; ref: string }
	| { id: "range"; base: string; head: string };

export interface ScopeOptions {
	/** review root — `FileDiff.path` values are relative to it */
	cwd: string;
	/** Claude Code state directory: our own artifacts never show up in a diff */
	claudeDir: string;
	/** null — nothing explicit was asked for */
	request: ScopeRequest | null;
}

export interface ScopeList {
	/** every non-empty scope, in display order */
	changesets: Changeset[];
	/** what the viewer opens first; null — nothing to review */
	activeId: ScopeId | null;
}

/** How a scope is built, before it is known whether it has any files. */
interface ScopeSpec {
	id: ScopeId;
	label: string;
	/** how the comparison is named to the user — reaches the batch header */
	against: string;
	/** revision the old side is read from */
	base: string;
	/** revision the new side is read from; null — the working tree or the index */
	head: string | null;
	/** compare the index instead of the working tree (`--cached`) */
	staged: boolean;
	/** untracked files join the diff — only where the new side IS the working tree */
	untracked: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	return stdout;
}

/** Trimmed stdout, or null when git exits non-zero — for the many "does this exist" probes. */
async function gitQuiet(cwd: string, args: string[]): Promise<string | null> {
	try {
		return (await git(cwd, args)).trim();
	} catch {
		return null;
	}
}

/**
 * Root of the repository that owns `cwd`; null — not a repository or no git.
 * Silent: whoever builds the diff warns, not whoever anchors the review root
 * (`run.ts` calls this on `collect` too, where there is nothing to complain about).
 */
export async function gitToplevel(cwd: string): Promise<string | null> {
	return gitQuiet(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function buildScopes(options: ScopeOptions): Promise<ScopeList> {
	let root: string;
	try {
		root = (await git(options.cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			log.warn("git not found in PATH — there is nothing to diff.");
		} else {
			log.warn(`${options.cwd} is not a git repository — there is nothing to diff.`);
		}
		return { changesets: [], activeId: null };
	}

	const base = await diffBase(root);
	const specs = await planScopes(root, base, options.request);
	const own = ownArtifactPrefix(root, options.claudeDir);
	const texts: TextCache = new Map();

	const changesets: Changeset[] = [];
	for (const spec of specs) {
		const changeset = await buildChangeset(root, spec, own, texts);
		if (changeset !== null) changesets.push(changeset);
	}

	return { changesets, activeId: pickActive(changesets, options.request) };
}

/**
 * The scope the viewer opens on. An explicit request wins even over an empty
 * result — reporting "nothing is staged" beats silently showing something else.
 * Otherwise the first scope that has files: a clean working tree with commits on
 * the branch opens on `since`, which used to be a flat "No changes".
 */
function pickActive(changesets: Changeset[], request: ScopeRequest | null): ScopeId | null {
	if (request !== null) {
		return changesets.some((changeset) => changeset.id === request.id) ? request.id : null;
	}
	for (const id of ["worktree", "since", "staged"] as const) {
		if (changesets.some((changeset) => changeset.id === id)) return id;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Planning: which scopes this run offers
// ---------------------------------------------------------------------------

async function planScopes(root: string, base: string, request: ScopeRequest | null): Promise<ScopeSpec[]> {
	const specs: ScopeSpec[] = [{
		id: "worktree",
		label: "Working tree",
		against: base === "HEAD" ? "HEAD" : "the empty tree",
		base,
		head: null,
		staged: false,
		untracked: true,
	}];

	// The index is normally identical to HEAD in an agent session — the scope
	// appears only for the human who staged something on purpose.
	const staged = await gitQuiet(root, ["diff", "--cached", "--name-only", base]);
	if (request?.id === "staged" || (staged !== null && staged !== "")) {
		specs.push({
			id: "staged",
			label: "Staged",
			against: base === "HEAD" ? "HEAD" : "the empty tree",
			base,
			head: null,
			staged: true,
			untracked: false,
		});
	}

	if (request?.id === "range") {
		specs.push(await rangeSpec(root, request.base, request.head));
		return specs;
	}

	const ref = request?.id === "since" ? request.ref : await defaultBaseRef(root);
	if (ref !== null) {
		const spec = await sinceSpec(root, ref, request?.id === "since");
		if (spec !== null) specs.push(spec);
	}
	return specs;
}

/**
 * Comparison base for the uncommitted scopes. Usually HEAD; in a repository
 * without a single commit it does not exist yet — then we compare against the
 * empty tree, and everything staged honestly becomes "added".
 */
async function diffBase(root: string): Promise<string> {
	const head = await gitQuiet(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	if (head !== null) return "HEAD";
	return (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).trim();
}

/**
 * Everything this branch added, committed or not: from the point it left the base
 * branch up to the working tree. Deliberately NOT `git diff <ref>` — that one
 * also reverses whatever the base branch gained in the meantime.
 *
 * null — the scope is not worth offering: no such revision, no common ancestor,
 * or the branch point IS HEAD, in which case it would duplicate the working tree.
 * An explicit request gets an error or an explanation instead of silence.
 */
async function sinceSpec(root: string, ref: string, explicit: boolean): Promise<ScopeSpec | null> {
	const resolved = await gitQuiet(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	if (resolved === null) {
		if (explicit) throw new ReviewError(`unknown revision: ${ref}`, EXIT.usage);
		return null;
	}
	const mergeBase = await gitQuiet(root, ["merge-base", resolved, "HEAD"]);
	if (mergeBase === null) {
		if (explicit) throw new ReviewError(`${ref} and HEAD have no common ancestor`, EXIT.usage);
		return null;
	}
	if (mergeBase === await gitQuiet(root, ["rev-parse", "HEAD"])) {
		if (explicit) log.info(`${ref} is an ancestor of HEAD — everything since it is the working tree.`);
		return null;
	}
	return {
		id: "since",
		label: `Since ${ref}`,
		against: ref,
		base: mergeBase,
		head: null,
		staged: false,
		untracked: true,
	};
}

/** A plain two-revision comparison: no merge base, no working tree, no untracked files. */
async function rangeSpec(root: string, base: string, head: string): Promise<ScopeSpec> {
	for (const rev of [base, head]) {
		if ((await gitQuiet(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])) === null) {
			throw new ReviewError(`unknown revision: ${rev}`, EXIT.usage);
		}
	}
	return {
		id: "range",
		label: `${base}..${head}`,
		against: `${base}..${head}`,
		base,
		head,
		staged: false,
		untracked: false,
	};
}

/**
 * The branch this repository forks from. `origin/HEAD` is the only place git
 * records the remote's default branch by name, so it is asked first and the
 * conventional names are the fallback; a local branch wins over the remote ref
 * because that is the name the human thinks in.
 */
async function defaultBaseRef(root: string): Promise<string | null> {
	const remoteHead = await gitQuiet(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	const named = remoteHead === null ? null : remoteHead.replace(/^origin\//, "");
	const seen = new Set<string>();
	for (const candidate of [named, "main", "master"]) {
		if (candidate === null || candidate === "" || seen.has(candidate)) continue;
		seen.add(candidate);
		if ((await gitQuiet(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) !== null) {
			return candidate;
		}
		if ((await gitQuiet(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`])) !== null) {
			return `origin/${candidate}`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Building one scope
// ---------------------------------------------------------------------------

async function buildChangeset(
	root: string,
	spec: ScopeSpec,
	own: string | null,
	texts: TextCache,
): Promise<Changeset | null> {
	const args = [...DIFF_ARGS];
	if (spec.staged) args.push("--cached");
	args.push(spec.base);
	if (spec.head !== null) args.push(spec.head);

	const isOwn = (path: string): boolean => own !== null && path.startsWith(own);
	const files = parseGitPatch(await git(root, args)).filter((file) => !isOwn(file.path));
	if (spec.untracked) {
		for (const path of await untrackedPaths(root)) {
			if (isOwn(path)) continue;
			const file = await untrackedFileDiff(root, path, texts);
			if (file !== null) files.push(file);
		}
	}
	await fillSideTexts(root, spec, files, texts);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	log.debug(`scope ${spec.id}: ${files.length} file(s), base ${spec.base}${spec.head === null ? "" : `..${spec.head}`}`);
	if (files.length === 0) return null;
	return { id: spec.id, label: spec.label, against: spec.against, root, files };
}

async function untrackedPaths(root: string): Promise<string[]> {
	const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	return out.split("\0").filter((path) => path !== "");
}

/**
 * Our own state files are never shown in the diff. Since D30 they live outside
 * the tree, so normally nothing matches — but `CLAUDE_CONFIG_DIR` may point
 * INTO the repository (a project-local Claude Code config), and then the whole
 * pre-D30 failure returns: the previous run's handoff becomes an untracked file
 * of the next one and its text travels into the new handoff's `newText`, which
 * grew it roughly threefold per run.
 *
 * null — the state directory is outside the root and there is nothing to filter.
 */
function ownArtifactPrefix(root: string, claudeDir: string): string | null {
	const rel = relative(root, reviewStateDir(root, claudeDir));
	return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : `${rel}/`;
}

/** null — the file disappeared between `ls-files` and reading; skip silently. */
async function untrackedFileDiff(
	root: string,
	path: string,
	texts: TextCache,
): Promise<FileDiff | null> {
	const text = await workingCopy(root, path, texts);
	if (text === null) return null;
	if (text === BINARY) return { path, changeKind: "added", binary: true, hunks: [] };
	const file: FileDiff = { path, changeKind: "added", binary: false, hunks: [], newText: text };
	if (text !== "") file.hunks.push(wholeFileHunk(text));
	return file;
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
 * `readFileSource`. The scopes overlap heavily (the working tree is a subset of
 * `since`), so every read goes through one per-run cache; without it the same
 * file is fetched once per scope. Not filled for binaries.
 */
async function fillSideTexts(
	root: string,
	spec: ScopeSpec,
	files: FileDiff[],
	texts: TextCache,
): Promise<void> {
	for (const file of files) {
		if (file.binary) continue;
		if (file.changeKind !== "added" && file.oldText === undefined) {
			const oldPath = file.previousPath ?? file.path;
			const text = await blob(root, `${spec.base}:${oldPath}`, texts);
			if (text !== null) file.oldText = text;
		}
		if (file.changeKind !== "deleted" && file.newText === undefined) {
			const text = await newSideText(root, spec, file.path, texts);
			if (text !== null && text !== BINARY) file.newText = text;
		}
	}
}

/**
 * Where the new side lives depends on the scope: a revision for a range, the
 * index (`:path`) for the staged scope, the file on disk for everything else.
 */
function newSideText(
	root: string,
	spec: ScopeSpec,
	path: string,
	texts: TextCache,
): Promise<TextResult> {
	if (spec.head !== null) return blob(root, `${spec.head}:${path}`, texts);
	if (spec.staged) return blob(root, `:${path}`, texts);
	return workingCopy(root, path, texts);
}

/** "Read fine, but it is not text" — distinct from null, which is "could not read". */
const BINARY = Symbol("binary");

type TextResult = string | typeof BINARY | null;

/** Keyed by where the text came from: `rev:<rev>:<path>` or `wt:<path>`. */
type TextCache = Map<string, TextResult>;

async function blob(root: string, rev: string, texts: TextCache): Promise<string | null> {
	const key = `rev:${rev}`;
	const hit = texts.get(key);
	if (hit !== undefined) return hit === BINARY ? null : hit;
	let text: string | null;
	try {
		text = await git(root, ["cat-file", "blob", rev]);
	} catch {
		log.debug(`scopes: failed to read ${rev}`);
		text = null;
	}
	texts.set(key, text);
	return text;
}

async function workingCopy(root: string, path: string, texts: TextCache): Promise<TextResult> {
	const key = `wt:${path}`;
	const hit = texts.get(key);
	if (hit !== undefined) return hit;
	let text: TextResult;
	try {
		const buffer = await readFile(join(root, path));
		// Git's own heuristic: a NUL in the first 8 KiB means binary.
		text = buffer.subarray(0, 8192).includes(0) ? BINARY : buffer.toString("utf8");
	} catch {
		log.debug(`scopes: failed to read the working copy of ${path}`);
		text = null;
	}
	texts.set(key, text);
	return text;
}
