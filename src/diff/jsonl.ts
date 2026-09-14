// Parser of the Claude Code session's JSONL transcript for the per-turn source (T4).
//
// Record schemas — ARCHITECTURE.md §4.2, §4.3, verified against real sessions:
// - user messages (turn boundaries, prompt snippets);
// - `file-history-snapshot`: `messageId` == `uuid` of the user record,
//   `snapshot.trackedFileBackups` is a CUMULATIVE set of tracked files
//   with the version in `backupFileName` (`<hash>@vN`);
// - `file-history-delta`: appears when a file is first taken under tracking
//   within a turn (observed — only `@v1`);
// - `toolUseResult` of Edit/Write (`type: "update"|"create"`): material for
//   fallback replay — `originalFile`, `content`, `structuredPatch`.
//
// Policy towards the foreign format (it is officially internal and may change):
// unknown record TYPES are skipped silently, but a known type with an unknown
// shape is a reason to give up and degrade (TurnsSchemaError is caught upstream
// and falls back to current with a message; a spec requirement).

import { readFileSync } from "node:fs";

/** The format is not the one we know: upstream degrades to current. */
export class TurnsSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TurnsSchemaError";
	}
}

export interface TurnRecord {
	/** 1-based turn number: T1, T2, … in the order of user messages */
	index: number;
	uuid: string;
	/** short prompt snippet for the turn's label */
	snippet: string;
}

export interface BackupRef {
	/** file name in `~/.claude/file-history/<session-id>/`; null — the file does not exist at this point */
	backupFileName: string | null;
	version: number | null;
	/** actual directory of the file on disk (keys can be relative) */
	realParentDir: string | null;
}

export interface SnapshotRecord {
	/** position in the transcript — for finding "trailing" deltas after the last snapshot */
	order: number;
	messageId: string;
	/** file path (as in the transcript) → reference to a version */
	entries: ReadonlyMap<string, BackupRef>;
}

export interface DeltaRecord {
	order: number;
	snapshotMessageId: string | null;
	trackingPath: string;
	backup: BackupRef;
}

export interface ReplayEdit {
	order: number;
	/** number of the turn within which the edit happened (by position in the file) */
	turnIndex: number;
	/** absolute path from toolUseResult.filePath */
	filePath: string;
	/** content before the edit; null — the file did not exist (Write created it) */
	before: string | null;
	/** content after the edit */
	after: string;
}

export interface ParsedTranscript {
	turns: TurnRecord[];
	snapshots: SnapshotRecord[];
	deltas: DeltaRecord[];
	/** Edit/Write edits in transcript order — material for fallback replay */
	replayEdits: ReplayEdit[];
}

export const SNIPPET_LIMIT = 60;

/**
 * Prompt snippet: service wrappers (`/clear`, `!`-commands) are collapsed into
 * a human-readable form, then the first meaningful line with a length limit.
 */
export function promptSnippet(content: string): string {
	let text = content.trim();

	const command = /^<command-name>([^<]*)<\/command-name>/.exec(text);
	const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
	const message = /^<command-message>([^<]*)<\/command-message>/.exec(text);
	const wrapped = /^<(bash-stderr|bash-stdout|local-command-stdout)>([\s\S]*?)<\/\1>/.exec(text);
	if (command !== null) {
		const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
		text = `${(command[1] as string).trim()} ${(args?.[1] ?? "").trim()}`.trim();
	} else if (bash !== null) {
		text = `! ${(bash[1] as string).trim()}`;
	} else if (message !== null) {
		text = (message[1] as string).trim();
	} else if (wrapped !== null) {
		text = `[${wrapped[1] as string}] ${(wrapped[2] as string).trim()}`;
	}

	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed === "") return "(empty message)";
	return collapsed.length > SNIPPET_LIMIT ? `${collapsed.slice(0, SNIPPET_LIMIT - 1)}…` : collapsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A user record marking a turn boundary. Tool results are also `type: "user"`, but
 * their content is an array with `tool_result`; a real prompt is a string (or an
 * array of text/image blocks without tool_result). isMeta records (caveat, context
 * reports) and sidechain records of subagents are not turns.
 */
function asTurn(record: Record<string, unknown>): { uuid: string; snippet: string } | null {
	if (record["type"] !== "user" || record["isMeta"] === true || record["isSidechain"] === true) return null;
	const uuid = record["uuid"];
	if (typeof uuid !== "string" || uuid === "") return null;
	const message = record["message"];
	if (!isRecord(message)) return null;

	const content = message["content"];
	if (typeof content === "string") return { uuid, snippet: promptSnippet(content) };
	if (Array.isArray(content)) {
		let text: string | null = null;
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block["type"] === "tool_result") return null;
			if (text === null && block["type"] === "text" && typeof block["text"] === "string") {
				text = block["text"];
			}
		}
		if (text !== null) return { uuid, snippet: promptSnippet(text) };
	}
	return null;
}

function asBackupRef(value: unknown, where: string): BackupRef {
	if (!isRecord(value)) throw new TurnsSchemaError(`${where}: expected a backup record object`);
	const name = value["backupFileName"];
	if (name !== null && typeof name !== "string") {
		throw new TurnsSchemaError(`${where}: backupFileName is neither a string nor null`);
	}
	const version = value["version"];
	const realParentDir = value["realParentDir"];
	return {
		backupFileName: (name as string | null) ?? null,
		version: typeof version === "number" ? version : null,
		realParentDir: typeof realParentDir === "string" ? realParentDir : null,
	};
}

function asSnapshot(record: Record<string, unknown>, order: number): SnapshotRecord {
	const messageId = record["messageId"];
	if (typeof messageId !== "string" || messageId === "") {
		throw new TurnsSchemaError("file-history-snapshot without messageId");
	}
	const snapshot = record["snapshot"];
	if (!isRecord(snapshot)) throw new TurnsSchemaError("file-history-snapshot: snapshot field is not an object");
	const backups = snapshot["trackedFileBackups"];
	if (!isRecord(backups)) {
		throw new TurnsSchemaError("file-history-snapshot: trackedFileBackups is not an object");
	}
	const entries = new Map<string, BackupRef>();
	for (const [path, ref] of Object.entries(backups)) {
		entries.set(path, asBackupRef(ref, `trackedFileBackups[${path}]`));
	}
	return { order, messageId, entries };
}

function asDelta(record: Record<string, unknown>, order: number): DeltaRecord {
	const trackingPath = record["trackingPath"];
	if (typeof trackingPath !== "string" || trackingPath === "") {
		throw new TurnsSchemaError("file-history-delta without trackingPath");
	}
	const snapshotMessageId = record["snapshotMessageId"];
	return {
		order,
		snapshotMessageId: typeof snapshotMessageId === "string" ? snapshotMessageId : null,
		trackingPath,
		backup: asBackupRef(record["backup"], "file-history-delta.backup"),
	};
}

/** `structuredPatch` from toolUseResult: hunks with ready-made `+`/`-`/` ` lines. */
function applyStructuredPatch(original: string, patch: unknown): string | null {
	if (!Array.isArray(patch)) return null;
	const oldLines = original.split("\n");
	const out: string[] = [];
	let cursor = 0;
	for (const hunk of patch) {
		if (!isRecord(hunk) || typeof hunk["oldStart"] !== "number" || !Array.isArray(hunk["lines"])) {
			return null;
		}
		while (cursor < (hunk["oldStart"] as number) - 1) {
			if (cursor >= oldLines.length) return null;
			out.push(oldLines[cursor] as string);
			cursor += 1;
		}
		for (const line of hunk["lines"]) {
			if (typeof line !== "string") return null;
			if (line.startsWith("+")) out.push(line.slice(1));
			else if (line.startsWith("-")) cursor += 1;
			else if (line.startsWith("\\")) continue;
			else {
				out.push(line.slice(1));
				cursor += 1;
			}
		}
	}
	while (cursor < oldLines.length) {
		out.push(oldLines[cursor] as string);
		cursor += 1;
	}
	return out.join("\n");
}

/**
 * An edit from a toolUseResult of Edit/Write. Malformed records do not fail the
 * parse: replay is the last resort, its gaps are tolerable (return null — the
 * record is skipped).
 */
function asReplayEdit(record: Record<string, unknown>, order: number, turnIndex: number): ReplayEdit | null {
	const result = record["toolUseResult"];
	if (!isRecord(result)) return null;
	const kind = result["type"];
	if (kind !== "update" && kind !== "create") return null;
	const filePath = result["filePath"];
	if (typeof filePath !== "string" || filePath === "") return null;

	const originalFile = typeof result["originalFile"] === "string" ? (result["originalFile"] as string) : null;
	let after: string | null = typeof result["content"] === "string" ? (result["content"] as string) : null;
	if (after === null && originalFile !== null) {
		after = applyStructuredPatch(originalFile, result["structuredPatch"]);
	}
	if (after === null) return null;

	return {
		order,
		turnIndex,
		filePath,
		before: kind === "create" ? null : originalFile,
		after,
	};
}

/**
 * A single pass over the file. An unreadable file or garbage instead of JSONL —
 * TurnsSchemaError (degradation upstream); individual broken lines are tolerated.
 */
export function parseTranscript(path: string): ParsedTranscript {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new TurnsSchemaError(
			`cannot read the transcript: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const turns: TurnRecord[] = [];
	const snapshots: SnapshotRecord[] = [];
	const deltas: DeltaRecord[] = [];
	const replayEdits: ReplayEdit[] = [];
	let parsedLines = 0;
	let totalLines = 0;

	const lines = raw.split("\n");
	for (let order = 0; order < lines.length; order += 1) {
		const line = (lines[order] as string).trim();
		if (line === "") continue;
		totalLines += 1;

		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;
		parsedLines += 1;

		const type = record["type"];
		if (type === "file-history-snapshot") {
			snapshots.push(asSnapshot(record, order));
			continue;
		}
		if (type === "file-history-delta") {
			deltas.push(asDelta(record, order));
			continue;
		}
		const turn = asTurn(record);
		if (turn !== null) {
			turns.push({ index: turns.length + 1, ...turn });
			continue;
		}
		const edit = asReplayEdit(record, order, turns.length);
		if (edit !== null) replayEdits.push(edit);
	}

	if (totalLines === 0) throw new TurnsSchemaError("the transcript is empty");
	if (parsedLines === 0) throw new TurnsSchemaError("the transcript contains no JSON records");

	return { turns, snapshots, deltas, replayEdits };
}
