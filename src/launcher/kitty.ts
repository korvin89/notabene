// kitty launcher — flow B (ARCHITECTURE.md §5.3): a kitty tab via remote
// control. The launch mechanics were confirmed by the scripts/probe-kitty.sh probe.
//
// Pitfalls documented in §5.3 and hardwired here:
// - `kitty @ launch` runs the command in the environment of kitty ITSELF
//   (trimmed PATH under a GUI launch), so the viewer is invoked as a platform
//   binary by absolute path, and PATH/HOME are passed explicitly via `--env`.
//
// Waiting is NOT done via `--wait-for-child-to-exit`: on this machine
// (kitty 0.48.2) the `kitten @` client with that flag never returns control —
// verified live on a dummy command (`sh -c 'sleep 1'`): the child finished, the
// tab closed, the client kept hanging (T5, 2026-09-14; in the T1 probe the same
// flag worked, i.e. the behavior is unstable). So the window is launched
// without waiting, and its death is polled: `ls --match id:<wid>` exits 0 while
// the window is alive and 1 with a clear error once it has closed.
// This also fixes a hung `!ntb`: the polling is interruptible by timeout and
// Ctrl-C, which never happened with a hung client.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ReviewError, log } from "../io.ts";
import { extensionDir, resolveHunkBinary } from "../hunk/bin.ts";
import { HANDOFF_ENV, mirrorPath } from "../hunk/handoff.ts";
import { collectComments } from "../hunk/notes.ts";
import type { ReviewComment } from "../model/review.ts";
import type { DoneReason, Launcher, LauncherContext, OpenOptions, WaitOptions } from "./types.ts";

const KITTY_APP = "/Applications/kitty.app/Contents/MacOS/kitty";

/** Window-liveness polling interval. A second is unnoticeable to a human and cheap. */
const POLL_MS = 1000;

/**
 * If the window disappeared within this time and the extension never checked
 * in, we assume the viewer failed to start at all (the most common case — the
 * binary was not found).
 */
const STARTUP_MS = 3000;

/**
 * How many consecutive `kitten @` client non-answers we tolerate before giving
 * up. The socket may have been recreated (kitty restart), and the review must
 * not die because of that: the comments are already typed in, and only the
 * normal end of the wait will pick them up.
 */
const MAX_CLIENT_ERRORS = 3;

function resolveKittyBin(env: NodeJS.ProcessEnv): string {
	const override = env["NOTABENE_KITTY"];
	if (override !== undefined && override !== "") return override;
	if (existsSync(KITTY_APP)) return KITTY_APP;
	return "kitty";
}

function runKitty(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(bin, args, (error, stdout, stderr) => {
			if (error !== null && typeof (error as NodeJS.ErrnoException).errno === "number" && stdout === "" && stderr === "") {
				reject(new ReviewError(`kitty failed to start (${bin}): ${error.message}`));
				return;
			}
			resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
		});
	});
}

export function kittyLauncher(ctx: LauncherContext): Launcher {
	let kittyBin = "kitty";
	let listenOn = "";
	let windowId: string | null = null;
	let openedAt = 0;
	let clientErrors = 0;

	/**
	 * true — remote control replied "the window exists"; false — no window. The
	 * `kitten @` client itself may also fail to start (socket recreated): a few
	 * of those in a row count as noise and we keep waiting; persistent ones —
	 * an error.
	 */
	const windowAlive = async (): Promise<boolean> => {
		let result: { code: number; stdout: string; stderr: string };
		try {
			result = await runKitty(kittyBin, ["@", "--to", listenOn, "ls", "--match", `id:${windowId ?? ""}`]);
		} catch (error) {
			clientErrors += 1;
			if (clientErrors > MAX_CLIENT_ERRORS) throw error;
			log.debug(`kitty: client did not respond (${clientErrors}/${MAX_CLIENT_ERRORS}), still waiting`);
			return true;
		}
		clientErrors = 0;
		return result.code === 0;
	};

	return {
		name: "kitty",
		blocking: true,

		async open(options: OpenOptions): Promise<void> {
			const availability = ctx.detected.kitty;
			if (availability.listenOn === null) {
				throw new ReviewError(`kitty-launcher unavailable: ${availability.reason}`);
			}
			listenOn = availability.listenOn;
			kittyBin = resolveKittyBin(options.env);
			const hunkBin = resolveHunkBinary(options.env);

			const args = [
				"@", "--to", listenOn,
				"launch", "--type=tab", "--title", `notabene: ${options.label}`,
				`--cwd=${options.cwd}`,
				"--env", `PATH=${options.env["PATH"] ?? ""}`,
				"--env", `HOME=${options.env["HOME"] ?? ""}`,
				"--env", `${HANDOFF_ENV}=${options.handoffPath}`,
				hunkBin, "diff", "--extension", extensionDir(),
			];
			log.debug(`kitty: ${kittyBin} ${args.join(" ")}`);

			const launched = await runKitty(kittyBin, args);
			const id = launched.stdout.trim();
			if (launched.code !== 0 || !/^\d+$/.test(id)) {
				throw new ReviewError(
					`kitty @ launch did not open a tab: ${launched.stderr.trim() || launched.stdout.trim() || `code ${launched.code}`}`,
				);
			}
			windowId = id;
			openedAt = Date.now();
			log.debug(`kitty: window ${windowId}`);
		},

		async waitForDone(options: WaitOptions): Promise<DoneReason> {
			if (windowId === null) throw new ReviewError("kitty-launcher: waitForDone before open");
			const deadline = openedAt + options.timeoutMs;

			while (Date.now() < deadline) {
				if (options.signal?.aborted === true) return "interrupted";
				if (!(await windowAlive())) {
					// A viewer that failed to start dies instantly and leaves no trace
					// of the extension — this is not a "review with no comments".
					if (Date.now() - openedAt < STARTUP_MS && !existsSync(mirrorPath(ctx.stateDir))) {
						throw new ReviewError(
							"the kitty tab closed immediately — the viewer did not start. Most often "
								+ "the hunk binary was not found: run `npm install` in the notabene directory.",
						);
					}
					return "viewer-exited";
				}
				try {
					// Ctrl-C interrupts the pause itself instead of waiting for the next tick.
					await delay(POLL_MS, undefined, { signal: options.signal });
				} catch {
					return "interrupted";
				}
			}
			return "timeout";
		},

		async collect(): Promise<ReviewComment[]> {
			return collectComments(ctx.stateDir);
		},
	};
}
