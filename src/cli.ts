// The `ntb` entry point. Command dispatch, exit codes, Ctrl-C handling.
// The actual workflow lives in run.ts.
//
// The surface is commands, not mode flags (DECISIONS.md D26): the modes are
// mutually exclusive by nature — `run.ts` already models them as `RunMode` — and
// spelling them as flags meant hand-written "these two cannot be combined"
// checks plus flags that were silently ignored by the mode that did not use them.
// Each command declares its own option table, so both problems are gone by
// construction.
//
// The command is the first argument, or `review` when the first argument is a
// flag: `!ntb` with no arguments is the headline path and must stay bare.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { EXIT, ReviewError, emit, log, setVerbose } from "./io.ts";
import type { ExitCode } from "./io.ts";
import { DEFAULT_TIMEOUT_MS, LAUNCHER_CHAIN } from "./launcher/index.ts";
import type { LauncherName } from "./launcher/index.ts";
import { dump, run } from "./run.ts";
import type { RunMode, RunOptions } from "./run.ts";
import { defaultSessionContext } from "./session/index.ts";
import { update } from "./update.ts";

const USAGE = `ntb — diff review for Claude Code: your comments on the agent's turn go back into its context as a batch.

Usage:
  ntb [review] [--turn N] [--launcher NAME] [--timeout MIN] [--context]
                        show the diff in the viewer, wait, and print the batch
  ntb open [--turn N] [--launcher NAME] [--timeout MIN] [--context]
                        only prepare the review and open the viewer (flow C, step 1)
  ntb collect [--context]
                        pick up comments from the open viewer (flow C, step 2)
  ntb update [--check]  update this install to the newest release
  ntb dump WHAT         debugging: current | turns | session | env — JSON to stdout

Review flags:
  --turn N              review turn T<N> instead of the current state
  --launcher NAME       ${LAUNCHER_CHAIN.join(" | ")} — bypass environment detection
  --timeout MIN         how long to wait for the viewer, default 30
  --context             add context lines to the batch items

Everywhere:
  --verbose             diagnostics to stderr
  -h, --help            this help
  -V, --version         version

Output contract: stdout receives only the final comment batch — or nothing when
there are no comments. Claude reads that text. Everything else goes to stderr.`;

const COMMANDS = ["review", "open", "collect", "update", "dump", "help"] as const;

type Command = (typeof COMMANDS)[number];

const EVERYWHERE = {
	help: { type: "boolean", short: "h" },
	verbose: { type: "boolean" },
} as const;

/** Modifiers of a review: what to show and where. */
const REVIEW_FLAGS = {
	turn: { type: "string" },
	launcher: { type: "string" },
	timeout: { type: "string" },
	context: { type: "boolean" },
} as const;

/**
 * One table per command — this is what makes `ntb collect --launcher kitty` a
 * usage error instead of a silently ignored flag (collect builds no launcher).
 */
const OPTIONS: Record<Command, ParseArgsConfig["options"]> = {
	review: { ...EVERYWHERE, ...REVIEW_FLAGS, version: { type: "boolean", short: "V" } },
	open: { ...EVERYWHERE, ...REVIEW_FLAGS },
	// No launcher, no timeout: collection waits for nothing (ARCHITECTURE.md §5.4).
	collect: { ...EVERYWHERE, context: { type: "boolean" } },
	update: { ...EVERYWHERE, check: { type: "boolean" } },
	dump: { ...EVERYWHERE },
	help: { ...EVERYWHERE },
};

/**
 * The command is the first argument. A leading flag means the default command,
 * so `ntb --turn 3` keeps working; an unknown word is refused rather than
 * guessed at, which is what keeps `ntb review main feature` available later.
 */
function splitCommand(argv: string[]): { command: Command; rest: string[] } {
	const first = argv[0];
	if (first === undefined || first.startsWith("-")) return { command: "review", rest: argv };
	if (!(COMMANDS as readonly string[]).includes(first)) {
		throw new ReviewError(`unknown command: ${first} (available: ${COMMANDS.join(", ")})`, EXIT.usage);
	}
	return { command: first as Command, rest: argv.slice(1) };
}

function packageVersion(): string {
	try {
		const raw = readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		if (typeof parsed.version === "string") return parsed.version;
	} catch {
		// the version is not worth crashing over
	}
	return "0.0.0";
}

/** Accepts both `3` and `T3` — turn labels carry the letter with the number. */
function parseTurn(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const parsed = Number.parseInt(raw.replace(/^[Tt]/, ""), 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new ReviewError(`--turn expects a turn number (e.g. 3 or T3), got: ${raw}`, EXIT.usage);
	}
	return parsed;
}

function parseTimeout(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_TIMEOUT_MS;
	const minutes = Number.parseFloat(raw);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new ReviewError(`--timeout expects minutes (>0), got: ${raw}`, EXIT.usage);
	}
	return Math.round(minutes * 60 * 1000);
}

function parseLauncher(raw: string | undefined): LauncherName | null {
	if (raw === undefined) return null;
	if (!LAUNCHER_CHAIN.includes(raw as LauncherName)) {
		throw new ReviewError(
			`--launcher expects one of: ${LAUNCHER_CHAIN.join(", ")}; got: ${raw}`,
			EXIT.usage,
		);
	}
	return raw as LauncherName;
}

async function main(argv: string[]): Promise<ExitCode> {
	let command: Command;
	let values: Record<string, string | boolean | undefined>;
	let positionals: string[];
	try {
		const split = splitCommand(argv);
		command = split.command;
		const parsed = parseArgs({
			args: split.rest,
			options: OPTIONS[command],
			strict: true,
			// Only `dump` takes an argument; elsewhere a stray word is a mistake
			// worth reporting rather than ignoring.
			allowPositionals: command === "dump",
		});
		values = parsed.values;
		positionals = parsed.positionals;
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		log.info(USAGE);
		return EXIT.usage;
	}

	if (command === "help" || values.help === true) {
		emit(USAGE);
		return EXIT.ok;
	}
	if (values.version === true) {
		emit(`ntb ${packageVersion()}`);
		return EXIT.ok;
	}
	setVerbose(values.verbose === true);

	const controller = new AbortController();
	let interrupts = 0;
	process.on("SIGINT", () => {
		interrupts += 1;
		if (interrupts > 1) process.exit(EXIT.interrupted);
		log.warn("interrupting; stdout will stay empty (press Ctrl-C again to exit immediately).");
		controller.abort();
	});

	try {
		// Maintenance: nothing to do with a review, so no session or repository
		// is resolved on this path.
		if (command === "update") return await update({ checkOnly: values.check === true });

		const mode: RunMode = command === "open" ? "open" : command === "collect" ? "collect" : "auto";
		const options: RunOptions = {
			mode,
			turn: parseTurn(typeof values.turn === "string" ? values.turn : undefined),
			timeoutMs: parseTimeout(typeof values.timeout === "string" ? values.timeout : undefined),
			launcher: parseLauncher(typeof values.launcher === "string" ? values.launcher : undefined),
			includeContext: values.context === true,
			ctx: defaultSessionContext(),
			signal: controller.signal,
		};

		if (command === "dump") {
			const what = positionals[0];
			if (what === undefined) {
				throw new ReviewError("dump expects a source: current | turns | session | env", EXIT.usage);
			}
			if (positionals.length > 1) {
				throw new ReviewError(`dump takes one source, got: ${positionals.join(" ")}`, EXIT.usage);
			}
			return await dump(what, options);
		}

		return await run(options);
	} catch (error) {
		if (error instanceof ReviewError) {
			log.error(error.message);
			return error.exitCode;
		}
		log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		return EXIT.failure;
	}
}

process.exitCode = await main(process.argv.slice(2));
