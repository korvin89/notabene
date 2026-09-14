// Output contract (ARCHITECTURE.md §3.1, §6).
//
// stdout is sacred: under `!` it lands in Claude's context verbatim, so it
// receives ONLY the final comment batch — or nothing when the review is empty.
// All diagnostics, hints, and errors go to stderr (Claude sees it too, but its
// text does not read like an instruction).
//
// The only exception is the explicit informational commands (`ntb dump`,
// `--version`, `--help`): they are run by hand, and their output is the result.
//
// The invariant is held by `test/stdout-contract.test.ts`: writing to stdout
// is allowed from here only.

import process from "node:process";

export const EXIT = {
	/** all good (including "the review is empty, stdout is empty") */
	ok: 0,
	/** runtime failure */
	failure: 1,
	/** usage error: unknown flag, incompatible modes */
	usage: 2,
	/** hit a stub of an unimplemented ticket */
	notImplemented: 3,
	/** Ctrl-C */
	interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

let verbose = false;

export function setVerbose(value: boolean): void {
	verbose = value;
}

/** The only permitted write to stdout. */
export function emit(text: string): void {
	if (text === "") return;
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Whether the process has a live terminal. Under `!` both streams are pipes
 * (T1a); in a real terminal they are TTYs. Flow C uses this to decide between
 * opening the viewer right here and printing the instructions. The probe lives
 * next to the output contract on purpose.
 */
export function hasInteractiveTerminal(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function toStderr(prefix: string, message: string): void {
	process.stderr.write(`${prefix}${message}\n`);
}

export const log = {
	/** regular user-facing messages: hints, status */
	info(message: string): void {
		toStderr("", message);
	},
	warn(message: string): void {
		toStderr("ntb: ", message);
	},
	error(message: string): void {
		toStderr("ntb: ", message);
	},
	/** enabled by `--verbose`; for post-mortems of launchers and diff sources */
	debug(message: string): void {
		if (verbose) toStderr("ntb[debug]: ", message);
	},
};

/** An error the CLI shows to the user as is, without a stack trace. */
export class ReviewError extends Error {
	readonly exitCode: ExitCode;

	constructor(message: string, exitCode: ExitCode = EXIT.failure) {
		super(message);
		this.name = "ReviewError";
		this.exitCode = exitCode;
	}
}

/**
 * A stub behind a frozen interface. The ticket in the message makes the output
 * say which part of the plan is not done yet, rather than "something broke".
 */
export class NotImplementedError extends ReviewError {
	readonly ticket: string;

	constructor(ticket: string, what: string) {
		super(`not implemented (${ticket}): ${what}`, EXIT.notImplemented);
		this.name = "NotImplementedError";
		this.ticket = ticket;
	}
}
