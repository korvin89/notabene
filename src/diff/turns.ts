// The "turns" DiffSource: per-turn changesets from Claude Code's file-history (T4).
//
// The model (ARCHITECTURE.md §4.3, verified against real sessions):
// - a snapshot is written when a user message is SENT and captures the state of
//   the tracked files at the BEGINNING of the turn;
// - therefore "what turn N touched" = comparing snapshot N with the next available
//   snapshot by `backupFileName` (the set is CUMULATIVE, counting by size does
//   not work); turns without a snapshot (happens) are attributed to the previous one;
// - the versions themselves are full copies in `~/.claude/file-history/<session-id>/`;
// - for a file first taken under tracking within a turn, its "before" state lives
//   not in the snapshot (it is not there yet) but in the `@v1` backup of its
//   file-history-delta: the backup is written BEFORE the first edit (null — the
//   file really did not exist);
// - for the last snapshot there is nowhere to take "after" from except the disk;
//   the disk is read only inside the changeset root (see diskPathFor);
// - a lost backup → replay from Edit/Write toolUseResult; no way at all →
//   the file is skipped, and if nothing was recovered at all — degradation
//   to current (done by the turnsDiffSourceImpl wrapper).
//
// Turn numbering can diverge from the built-in /diff (service turns like /clear,
// gaps in snapshots), so the label always carries the prompt snippet.

import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { log } from "../io.ts";
import type { Changeset, DiffSource, FileChangeKind, FileDiff } from "../model/diff.ts";
import type { DiffSourceOptions } from "./index.ts";
import { TurnsSchemaError, parseTranscript } from "./jsonl.ts";
import type { BackupRef, ReplayEdit, SnapshotRecord, TurnRecord } from "./jsonl.ts";
import { diffTexts } from "./text-diff.ts";

/** The source is intact but the per-turn data is insufficient: degradation upstream. */
export class TurnsUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TurnsUnavailableError";
	}
}

/**
 * Wrapper with degradation (a spec requirement): an unfamiliar schema or an
 * unavailable file-history does not fail the review but falls back to `fallback`
 * (usually current) with a clear message on stderr.
 */
export function turnsDiffSourceImpl(options: DiffSourceOptions, fallback: DiffSource): DiffSource {
	return {
		name: "turns",
		async changesets(): Promise<Changeset[]> {
			try {
				return buildTurnChangesets(options);
			} catch (error) {
				if (error instanceof TurnsSchemaError || error instanceof TurnsUnavailableError) {
					log.warn(`per-turn diff unavailable: ${error.message} — degrading to current.`);
					return fallback.changesets();
				}
				throw error;
			}
		},
	};
}

// ───────────────────────── internals ─────────────────────────

/** A side of a file's diff: where to take the full text from. */
type SideRef =
	| { kind: "absent" }
	| { kind: "backup"; name: string }
	| { kind: "disk"; path: string | null };

interface Candidate {
	/** path as recorded in the transcript (relative or absolute) */
	key: string;
	ref: BackupRef | null;
	oldSide: SideRef;
	newSide: SideRef;
}

interface ReplayPair {
	before: string | null;
	after: string;
}

class Assembly {
	private readonly historyDir: string;
	private readonly root: string;
	private readonly contentCache = new Map<string, string | null>();
	private readonly replayByTurn: Map<number, Map<string, ReplayPair>>;
	/** files that could not be recovered by backup or by replay */
	lostFiles = 0;
	/** sides recovered by replay instead of a missing backup */
	replayedFiles = 0;

	constructor(options: DiffSourceOptions, replayEdits: ReplayEdit[]) {
		this.historyDir = join(options.claudeDir, "file-history", options.session.sessionId);
		this.root = options.cwd;
		this.replayByTurn = indexReplay(replayEdits);
	}

	/** Absolute path of a key: `realParentDir` is more precise than resolving from the root. */
	private absPathFor(key: string, ref: BackupRef | null): string {
		if (isAbsolute(key)) return key;
		if (ref?.realParentDir !== null && ref?.realParentDir !== undefined) {
			return join(ref.realParentDir, basename(key));
		}
		return resolve(this.root, key);
	}

	/**
	 * The disk is read only inside the changeset root: file-history outlives both
	 * deleted worktrees and files outside the project — pulling them from the live
	 * disk would show foreign/stale state. null — must not read.
	 */
	diskPathFor(key: string, ref: BackupRef | null): string | null {
		const abs = this.absPathFor(key, ref);
		return abs === this.root || abs.startsWith(this.root + sep) ? abs : null;
	}

	private readCached(cacheKey: string, path: string): string | null {
		const hit = this.contentCache.get(cacheKey);
		if (hit !== undefined) return hit;
		let content: string | null;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			content = null;
		}
		this.contentCache.set(cacheKey, content);
		return content;
	}

	private replayFor(turnIndex: number, key: string, ref: BackupRef | null): ReplayPair | null {
		const perFile = this.replayByTurn.get(turnIndex);
		if (perFile === undefined) return null;
		const exact = perFile.get(this.absPathFor(key, ref));
		if (exact !== undefined) return exact;
		if (!isAbsolute(key)) {
			for (const [path, pair] of perFile) {
				if (path.endsWith(`/${key}`)) return pair;
			}
		}
		return null;
	}

	fileDiff(turnIndex: number, candidate: Candidate): FileDiff | null {
		const replay = this.replayFor(turnIndex, candidate.key, candidate.ref);
		let usedReplay = false;

		// undefined — the side's data is lost, the file will have to be skipped
		const sideText = (side: SideRef, replayText: string | null | undefined): string | null | undefined => {
			if (side.kind === "absent") return null;
			if (side.kind === "disk") {
				return side.path === null ? null : this.readCached(`disk:${side.path}`, side.path);
			}
			const backup = this.readCached(`backup:${side.name}`, join(this.historyDir, side.name));
			if (backup !== null) return backup;
			if (replayText !== undefined) {
				usedReplay = true;
				return replayText;
			}
			return undefined;
		};

		const oldText = sideText(candidate.oldSide, replay?.before);
		const newText = sideText(candidate.newSide, replay?.after);
		if (oldText === undefined || newText === undefined) {
			this.lostFiles += 1;
			log.debug(`turn T${turnIndex}: no data for ${candidate.key} — skipping`);
			return null;
		}
		if (usedReplay) this.replayedFiles += 1;
		return makeFileDiff(this.displayPath(candidate.key, candidate.ref), oldText, newText);
	}

	displayPath(key: string, ref: BackupRef | null): string {
		const abs = isAbsolute(key) ? key : this.absPathFor(key, ref);
		if (abs.startsWith(this.root + sep)) return abs.slice(this.root.length + 1);
		return key;
	}

	replayOnlyDiffs(turnIndex: number): FileDiff[] {
		const perFile = this.replayByTurn.get(turnIndex);
		if (perFile === undefined) return [];
		const files: FileDiff[] = [];
		for (const [path, pair] of perFile) {
			const diff = makeFileDiff(this.displayPath(path, null), pair.before, pair.after);
			if (diff !== null) files.push(diff);
		}
		return files;
	}
}

function indexReplay(edits: ReplayEdit[]): Map<number, Map<string, ReplayPair>> {
	const byTurn = new Map<number, Map<string, ReplayPair>>();
	for (const edit of edits) {
		let perFile = byTurn.get(edit.turnIndex);
		if (perFile === undefined) {
			perFile = new Map();
			byTurn.set(edit.turnIndex, perFile);
		}
		const existing = perFile.get(edit.filePath);
		// the turn's first edit gives the "before" state, the last one — the "after"
		if (existing === undefined) perFile.set(edit.filePath, { before: edit.before, after: edit.after });
		else existing.after = edit.after;
	}
	return byTurn;
}

function makeFileDiff(path: string, oldText: string | null, newText: string | null): FileDiff | null {
	if (oldText === newText) return null;
	const changeKind: FileChangeKind = oldText === null ? "added" : newText === null ? "deleted" : "modified";
	const binary = (oldText !== null && oldText.includes("\0")) || (newText !== null && newText.includes("\0"));
	const hunks = binary ? [] : diffTexts(oldText ?? "", newText ?? "");
	if (!binary && hunks.length === 0) return null; // meaningfully empty (e.g. "" versus a missing file)
	const diff: FileDiff = { path, changeKind, binary, hunks };
	if (!binary && oldText !== null) diff.oldText = oldText;
	if (!binary && newText !== null) diff.newText = newText;
	return diff;
}

function sideOf(ref: BackupRef | undefined): SideRef {
	if (ref === undefined || ref.backupFileName === null) return { kind: "absent" };
	return { kind: "backup", name: ref.backupFileName };
}

function backupName(ref: BackupRef | undefined): string | null {
	return ref?.backupFileName ?? null;
}

export function buildTurnChangesets(options: DiffSourceOptions): Changeset[] {
	const transcriptPath = options.session.transcriptPath;
	if (transcriptPath === null) {
		throw new TurnsUnavailableError("session transcript not found");
	}
	const parsed = parseTranscript(transcriptPath);
	if (parsed.turns.length === 0) {
		throw new TurnsUnavailableError("the transcript has no user messages — turn boundaries are unknown");
	}

	const assembly = new Assembly(options, parsed.replayEdits);
	const turnByUuid = new Map(parsed.turns.map((turn) => [turn.uuid, turn]));

	// Snapshots anchored to turns. Foreign messageIds are skipped one by one, but
	// if not a single one anchored — the very contract "messageId == uuid of the
	// user message" has changed, and the schema can no longer be trusted.
	const anchored: { turn: TurnRecord; snapshot: SnapshotRecord }[] = [];
	for (const snapshot of parsed.snapshots) {
		const turn = turnByUuid.get(snapshot.messageId);
		if (turn === undefined) {
			log.debug(`snapshot ${snapshot.messageId} is not anchored to any turn — skipping`);
			continue;
		}
		anchored.push({ turn, snapshot });
	}
	if (parsed.snapshots.length > 0 && anchored.length === 0) {
		throw new TurnsSchemaError("no file-history-snapshot anchored to a user message");
	}

	if (anchored.length === 0) {
		// file-history vanished from the format, but Edit/Write edits are still recognizable — replay.
		if (parsed.replayEdits.length === 0) {
			throw new TurnsUnavailableError("the transcript has neither file-history nor Edit/Write edits");
		}
		log.warn("the transcript has no file-history snapshots — reconstructing turns from toolUseResult (replay).");
		const changesets: Changeset[] = [];
		for (const turn of parsed.turns) {
			const files = assembly.replayOnlyDiffs(turn.index);
			if (files.length > 0) changesets.push(makeChangeset(turn, files, options));
		}
		return finalize(changesets);
	}

	// The first delta of a file within a turn: its backup is the "before" state for
	// files not yet present in the snapshot at the turn's start. The key is the
	// messageId of the active snapshot (which is the turn's uuid; for turns without
	// a snapshot the deltas reference the previous one — consistent with attributing
	// their changes to it as well).
	const firstDeltaByTurn = new Map<string, Map<string, BackupRef>>();
	for (const delta of parsed.deltas) {
		if (delta.snapshotMessageId === null) continue;
		let perPath = firstDeltaByTurn.get(delta.snapshotMessageId);
		if (perPath === undefined) {
			perPath = new Map();
			firstDeltaByTurn.set(delta.snapshotMessageId, perPath);
		}
		if (!perPath.has(delta.trackingPath)) perPath.set(delta.trackingPath, delta.backup);
	}

	const perTurnFiles = new Map<number, FileDiff[]>();
	const addFile = (turnIndex: number, diff: FileDiff | null): void => {
		if (diff === null) return;
		const files = perTurnFiles.get(turnIndex) ?? [];
		if (files.some((existing) => existing.path === diff.path)) return;
		files.push(diff);
		perTurnFiles.set(turnIndex, files);
	};

	// "What turn N touched": adjacent snapshots, compared by backupFileName.
	let changedKeys = 0;
	for (let i = 0; i + 1 < anchored.length; i += 1) {
		const { turn, snapshot } = anchored[i] as { turn: TurnRecord; snapshot: SnapshotRecord };
		const next = (anchored[i + 1] as { snapshot: SnapshotRecord }).snapshot;
		for (const key of new Set([...snapshot.entries.keys(), ...next.entries.keys()])) {
			const oldRef = snapshot.entries.get(key);
			const newRef = next.entries.get(key);
			if (backupName(oldRef) === backupName(newRef)) continue;
			changedKeys += 1;
			let oldSide = sideOf(oldRef);
			if (oldSide.kind === "absent") {
				const preEdit = firstDeltaByTurn.get(turn.uuid)?.get(key);
				if (preEdit !== undefined && preEdit.backupFileName !== null) {
					oldSide = { kind: "backup", name: preEdit.backupFileName };
				}
			}
			addFile(turn.index, assembly.fileDiff(turn.index, {
				key,
				ref: newRef ?? oldRef ?? null,
				oldSide,
				newSide: sideOf(newRef),
			}));
		}
	}

	// The last snapshot: "after" exists only on disk. Candidates — all tracked files
	// plus trailing deltas (files first touched in the last turn). "File missing on
	// disk" is skipped silently: cannot distinguish "the agent deleted it" from
	// "the worktree was torn down / the file is outside the project".
	const last = anchored[anchored.length - 1] as { turn: TurnRecord; snapshot: SnapshotRecord };
	const lastCandidates = new Map<string, Candidate>();
	for (const [key, ref] of last.snapshot.entries) {
		lastCandidates.set(key, { key, ref, oldSide: sideOf(ref), newSide: { kind: "disk", path: null } });
	}
	for (const delta of parsed.deltas) {
		if (delta.order <= last.snapshot.order || lastCandidates.has(delta.trackingPath)) continue;
		lastCandidates.set(delta.trackingPath, {
			key: delta.trackingPath,
			ref: delta.backup,
			oldSide: sideOf(delta.backup),
			newSide: { kind: "disk", path: null },
		});
	}
	for (const candidate of lastCandidates.values()) {
		const diskPath = assembly.diskPathFor(candidate.key, candidate.ref);
		if (diskPath === null) continue;
		candidate.newSide = { kind: "disk", path: diskPath };
		const diff = assembly.fileDiff(last.turn.index, candidate);
		if (diff !== null && diff.changeKind !== "deleted") addFile(last.turn.index, diff);
	}

	if (assembly.replayedFiles > 0) {
		log.warn(`file-history is incomplete: ${assembly.replayedFiles} file(s) recovered by replay from toolUseResult.`);
	}
	if (assembly.lostFiles > 0) {
		log.warn(`file-history is incomplete: ${assembly.lostFiles} file(s) skipped — neither backup nor replay data.`);
	}
	if (perTurnFiles.size === 0 && changedKeys > 0 && assembly.lostFiles > 0) {
		throw new TurnsUnavailableError(
			`file-history backups are unavailable (${join(options.claudeDir, "file-history", options.session.sessionId)})`,
		);
	}

	const changesets: Changeset[] = [];
	for (const [turnIndex, files] of perTurnFiles) {
		changesets.push(makeChangeset(parsed.turns[turnIndex - 1] as TurnRecord, files, options));
	}
	return finalize(changesets);
}

function makeChangeset(turn: TurnRecord, files: FileDiff[], options: DiffSourceOptions): Changeset {
	files.sort((a, b) => a.path.localeCompare(b.path));
	return {
		id: `T${turn.index}`,
		mode: "turn",
		label: `Turn T${turn.index} ("${turn.snippet}")`,
		turn: turn.index,
		promptSnippet: turn.snippet,
		root: options.cwd,
		files,
	};
}

/** Display order — freshest turns first, like the switcher of the built-in /diff. */
function finalize(changesets: Changeset[]): Changeset[] {
	changesets.sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0));
	return changesets;
}
