// Launcher — the "show the changeset in a viewer, wait, collect" abstraction
// (DECISIONS.md D3). Born after the TTY probe failed: under `!` there is no
// controlling terminal, so the viewer lives elsewhere while `!ntb` waits
// for it synchronously.
//
// The changesets themselves are not passed to the launcher: run.ts writes them
// into the handoff file (src/hunk/handoff.ts) in advance, and the viewer reads
// it through our hunk extension. All that is left to the launcher is to start
// the viewer, wait, and collect.

import type { ReviewComment } from "../model/review.ts";
import type { LauncherEnvironment } from "./detect.ts";

/** Strategy chain: herdr → kitty → manual (ARCHITECTURE.md §5, DECISIONS.md D4). */
export type LauncherName = "herdr" | "kitty" | "manual";

/**
 * Everything an adapter needs at construction: detection and the review state
 * directory. The latter is NOT the review root — collection reads the handoff
 * and the mirror, and since D30 those live outside the repository.
 */
export interface LauncherContext {
	detected: LauncherEnvironment;
	stateDir: string;
}

export type DoneReason =
	/** the viewer closed on its own — the normal end of flow A/B */
	| "viewer-exited"
	/** the wait timed out: stdout is left empty, the viewer is left alone */
	| "timeout"
	/** Ctrl-C */
	| "interrupted"
	/** the launcher is non-blocking (flow C) — nothing to wait for, collection is a separate command */
	| "detached";

export interface OpenOptions {
	/** changeset root — the viewer's working directory */
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** handoff with the changesets, already written by run.ts */
	handoffPath: string;
	/** label of the changeset being opened — for the tab/pane title */
	label: string;
}

export interface WaitOptions {
	/** 4 hours by default (ARCHITECTURE.md §5.5); overridden by `--timeout` */
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface Launcher {
	readonly name: LauncherName;
	/**
	 * Whether `!ntb` blocks until viewing ends. Flows A and B — yes (one
	 * command), flow C — no (two commands: `open`, then `collect`).
	 */
	readonly blocking: boolean;
	/** show the prepared review: pane/tab/hint to the user */
	open(options: OpenOptions): Promise<void>;
	/** block until viewing ends */
	waitForDone(options: WaitOptions): Promise<DoneReason>;
	/** read the comments into our model; empty is a valid result */
	collect(): Promise<ReviewComment[]>;
}
