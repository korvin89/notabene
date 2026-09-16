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
import type { ScopeRequest } from "./diff/scopes.ts";
import { dump, run } from "./run.ts";
import type { RunMode, RunOptions } from "./run.ts";
import { defaultSessionContext } from "./session/index.ts";
import { update } from "./update.ts";

const USAGE = `ntb — diff review for Claude Code: your comments on the agent's changes go back into its context as a batch.

Usage:
  ntb [review] [REV | REV REV] [--staged] [--launcher NAME] [--timeout MIN] [--context]
                        show the diff in the viewer, wait, and print the batch
  ntb open [REV | REV REV] [--staged] [--launcher NAME] [--timeout MIN] [--context]
                        only prepare the review and open the viewer (flow C, step 1)
  ntb collect [--context]
                        pick up comments from the open viewer (flow C, step 2)
  ntb update [--check]  update this install to the newest release
  ntb dump WHAT [REV…]  debugging: scopes | session | env — JSON to stdout

Scope — what to review. Every scope that applies is offered in the viewer
(\`<\` \`>\` \`T\` switch between them); an argument only says which one opens first:
  ntb                   the working tree against HEAD, untracked files included
  ntb --staged          the index against HEAD
  ntb main              everything since this branch left main, committed or not
  ntb HEAD~3 HEAD       two revisions, nothing uncommitted

Review flags:
  --launcher NAME       ${LAUNCHER_CHAIN.join(" | ")} — bypass environment detection
  --timeout MIN         how long to wait for the viewer, default 240
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
	staged: { type: "boolean" },
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
	// `dump scopes` answers "what would a review show", so it takes a scope too —
	// but none of the flags about where to show it.
	dump: { ...EVERYWHERE, staged: { type: "boolean" } },
	help: { ...EVERYWHERE },
};

/**
 * The command is the first argument. Anything else — a flag or a revision —
 * means the default command, so both `ntb --staged` and `ntb main` work.
 *
 * A word that is neither a command nor a revision therefore fails later, as
 * "unknown revision", and a mistyped command lands there too; `inferred` is what
 * lets main() add the list of commands to that message.
 */
function splitCommand(argv: string[]): { command: Command; rest: string[]; inferred: boolean } {
	const first = argv[0];
	if (first !== undefined && (COMMANDS as readonly string[]).includes(first)) {
		return { command: first as Command, rest: argv.slice(1), inferred: false };
	}
	return { command: "review", rest: argv, inferred: first !== undefined && !first.startsWith("-") };
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

/**
 * The scope from the command line (ARCHITECTURE.md §4.2): nothing, `--staged`,
 * one revision (since its merge base with HEAD) or two (a plain comparison).
 * Whether the revisions exist is git's business, not the parser's.
 */
function parseScope(staged: boolean, positionals: string[]): ScopeRequest | null {
	if (staged) {
		if (positionals.length > 0) {
			throw new ReviewError(`--staged takes no revisions, got: ${positionals.join(" ")}`, EXIT.usage);
		}
		return { id: "staged" };
	}
	const [base, head, ...extra] = positionals;
	if (extra.length > 0) {
		throw new ReviewError(`expected at most two revisions, got: ${positionals.join(" ")}`, EXIT.usage);
	}
	if (base === undefined) return null;
	return head === undefined ? { id: "since", ref: base } : { id: "range", base, head };
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
	let inferred: boolean;
	let values: Record<string, string | boolean | undefined>;
	let positionals: string[];
	try {
		const split = splitCommand(argv);
		command = split.command;
		inferred = split.inferred;
		const parsed = parseArgs({
			args: split.rest,
			options: OPTIONS[command],
			strict: true,
			// `dump` takes its source, a review takes revisions; elsewhere a stray
			// word is a mistake worth reporting rather than ignoring.
			allowPositionals: command === "dump" || command === "review" || command === "open",
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
			// `dump` spends its first positional on the source name; the rest is a scope.
			scope: parseScope(values.staged === true, command === "dump" ? positionals.slice(1) : positionals),
			timeoutMs: parseTimeout(typeof values.timeout === "string" ? values.timeout : undefined),
			launcher: parseLauncher(typeof values.launcher === "string" ? values.launcher : undefined),
			includeContext: values.context === true,
			ctx: defaultSessionContext(),
			signal: controller.signal,
		};

		if (command === "dump") {
			const what = positionals[0];
			if (what === undefined) {
				throw new ReviewError("dump expects a source: scopes | session | env", EXIT.usage);
			}
			if (what !== "scopes" && positionals.length > 1) {
				throw new ReviewError(
					`dump ${what} takes no further arguments, got: ${positionals.slice(1).join(" ")}`,
					EXIT.usage,
				);
			}
			return await dump(what, options);
		}

		return await run(options);
	} catch (error) {
		if (error instanceof ReviewError) {
			log.error(error.message);
			// The first word was read as a revision because it is not a command —
			// which is exactly what a mistyped command looks like from here.
			if (inferred && error.exitCode === EXIT.usage) {
				log.info(`(\`${argv[0]}\` was read as a revision; the commands are: ${COMMANDS.join(", ")})`);
			}
			return error.exitCode;
		}
		log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		return EXIT.failure;
	}
}

process.exitCode = await main(process.argv.slice(2));
