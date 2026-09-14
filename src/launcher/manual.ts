// manual launcher — flow C (ARCHITECTURE.md §5.4): two steps, always works.
//
//   [you]     !ntb          → prepares the review, prints instructions, exits
//   [you]     ntb open      → in ANY other terminal: the viewer runs right there
//   [you]     !ntb collect  → the batch goes into Claude's context
//
// One implementation serves both calls: under `!` there is no terminal — print
// the instructions; in a live terminal — run hunk right here (stdio inherit)
// and wait for it to exit. Comment collection is shared by all flows
// (src/hunk/notes.ts).

import { spawn } from "node:child_process";
import { EXIT, ReviewError, hasInteractiveTerminal, log } from "../io.ts";
import { extensionDir, ntbCommand, resolveHunkBinary } from "../hunk/bin.ts";
import { HANDOFF_ENV } from "../hunk/handoff.ts";
import { collectComments } from "../hunk/notes.ts";
import type { ReviewComment } from "../model/review.ts";
import type { DoneReason, Launcher, LauncherContext, OpenOptions } from "./types.ts";

/** `NOTABENE_TTY=1|0` — forced mode for tests and non-standard environments. */
function isInteractive(env: NodeJS.ProcessEnv): boolean {
	const force = env["NOTABENE_TTY"];
	if (force === "1") return true;
	if (force === "0") return false;
	return hasInteractiveTerminal();
}

function runViewerHere(options: OpenOptions): Promise<void> {
	const hunkBin = resolveHunkBinary(options.env);
	log.debug(`manual: ${hunkBin} diff --extension ${extensionDir()} (cwd=${options.cwd})`);
	const child = spawn(hunkBin, ["diff", "--extension", extensionDir()], {
		cwd: options.cwd,
		env: { ...options.env, [HANDOFF_ENV]: options.handoffPath },
		stdio: "inherit",
	});
	return new Promise((resolve, reject) => {
		child.on("error", (error) =>
			reject(new ReviewError(`viewer failed to start (${hunkBin}): ${error.message}`)));
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			// Ctrl-C goes to the whole process group: the viewer was killed by a
			// signal, not broken. Any comments already typed are in the mirror —
			// `collect` will pick them up.
			if (signal !== null) {
				reject(new ReviewError(
					`viewer interrupted (${signal}); \`ntb collect\` will pick up what was typed`,
					EXIT.interrupted,
				));
				return;
			}
			reject(new ReviewError(`viewer exited with an error (code ${code ?? "?"})`));
		});
	});
}

export function manualLauncher(ctx: LauncherContext): Launcher {
	return {
		name: "manual",
		blocking: false,

		async open(options: OpenOptions): Promise<void> {
			if (isInteractive(options.env)) {
				log.info(`Opening ${options.label} in hunk (c — comment, < > T — turns, q — quit)…`);
				await runViewerHere(options);
				return;
			}
			log.info(
				"No terminal here — open the viewer in any other one:\n\n"
					+ `    cd ${options.cwd} && ${ntbCommand(options.env)} open\n\n`
					+ "Leave comments in hunk (c — comment, q — quit).",
			);
		},

		waitForDone(): Promise<DoneReason> {
			// Flow C does not wait: collection happens via a separate `ntb collect`.
			return Promise.resolve("detached");
		},

		async collect(): Promise<ReviewComment[]> {
			return collectComments(ctx.cwd);
		},
	};
}
