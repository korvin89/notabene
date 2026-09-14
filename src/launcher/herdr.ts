// herdr launcher — flow A (ARCHITECTURE.md §5.2): a Herdr pane next to Claude Code.
//
//   pane split --current --direction right --no-focus  → pane (or ours already,
//   found by name — reuse, §5.2)                       ← pane rename
//   pane run <id> "<cd … && hunk …; printf sentinel>"  → viewer in the pane
//   pane wait-output <id> --match <sentinel> --timeout → blocking
//   reading the comment mirror                         → batch
//
// The pane is deliberately NOT closed after the review: from the second run on
// it is found by name and simply reloaded (§5.2). All calls go through the herdr
// pane API, replies are structured JSON (works without a tty, verified in T1).
//
// The sentinel is printed by printf in TWO parts: otherwise wait-output would
// instantly "find" it in the echo of the typed command itself.

import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { ReviewError, log } from "../io.ts";
import { extensionDir, resolveHunkBinary } from "../hunk/bin.ts";
import { HANDOFF_ENV } from "../hunk/handoff.ts";
import { collectComments } from "../hunk/notes.ts";
import type { ReviewComment } from "../model/review.ts";
import type { DoneReason, Launcher, LauncherContext, OpenOptions, WaitOptions } from "./types.ts";

/** Name of the review pane — it is also how the pane gets reused on the next `!ntb`. */
const PANE_NAME = "notabene";

function resolveHerdrBin(env: NodeJS.ProcessEnv): string {
	const override = env["NOTABENE_HERDR"];
	return override !== undefined && override !== "" ? override : "herdr";
}

/** Shell single-quoting — the command goes to the pane's shell via `pane run`. */
function shq(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface HerdrReply {
	result?: unknown;
	error?: { code?: string; message?: string };
}

function parseReply(raw: string): HerdrReply | null {
	const start = raw.indexOf("{");
	if (start < 0) return null;
	try {
		return JSON.parse(raw.slice(start)) as HerdrReply;
	} catch {
		return null;
	}
}

function runHerdr(bin: string, env: NodeJS.ProcessEnv, args: string[]): Promise<HerdrReply> {
	log.debug(`herdr: ${args.join(" ")}`);
	return new Promise((resolve, reject) => {
		execFile(bin, args, { env }, (error, stdout, stderr) => {
			const reply = parseReply(stdout) ?? parseReply(stderr);
			if (reply?.error !== undefined) {
				reject(new ReviewError(`herdr ${args[0]} ${args[1]}: ${reply.error.message ?? reply.error.code ?? "error"}`));
				return;
			}
			if (error !== null && reply === null) {
				reject(new ReviewError(`herdr is not responding (${args.join(" ")}): ${stderr.trim() || error.message}`));
				return;
			}
			resolve(reply ?? {});
		});
	});
}

/** Extract the pane id from a reply without depending rigidly on the shape of `.result`. */
function paneIdOf(value: unknown): string | null {
	if (typeof value === "string" && value !== "") return value;
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	for (const key of ["id", "pane_id", "paneId"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate !== "") return candidate;
		if (typeof candidate === "number") return String(candidate);
	}
	return null;
}

/** Find our pane by name in `pane list` (defensive about the list shape). */
function findPaneByName(result: unknown, name: string): string | null {
	if (typeof result !== "object" || result === null) return null;
	const arrays = Array.isArray(result)
		? [result]
		: Object.values(result as Record<string, unknown>).filter(Array.isArray);
	for (const array of arrays) {
		for (const entry of array as unknown[]) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			if (record["label"] === name || record["title"] === name) {
				const id = paneIdOf(record);
				if (id !== null) return id;
			}
		}
	}
	return null;
}

export function herdrLauncher(ctx: LauncherContext): Launcher {
	let paneId: string | null = null;
	let sentinel = "";
	let herdrBin = "herdr";
	let waitEnv: NodeJS.ProcessEnv = {};

	return {
		name: "herdr",
		blocking: true,

		async open(options: OpenOptions): Promise<void> {
			herdrBin = resolveHerdrBin(options.env);
			waitEnv = options.env;
			const hunkBin = resolveHunkBinary(options.env);

			// Reuse by name: a second `!ntb` reloads the same pane.
			const list = await runHerdr(herdrBin, options.env, ["pane", "list"]).catch(() => null);
			paneId = list === null ? null : findPaneByName(list.result, PANE_NAME);

			if (paneId === null) {
				const split = await runHerdr(herdrBin, options.env, [
					"pane", "split", "--current", "--direction", "right", "--cwd", options.cwd, "--no-focus",
				]);
				const pane = (split.result as Record<string, unknown> | undefined)?.["pane"];
				paneId = paneIdOf(pane ?? split.result);
				if (paneId === null) {
					throw new ReviewError("herdr pane split returned no pane id — cannot open the viewer");
				}
				await runHerdr(herdrBin, options.env, ["pane", "rename", paneId, PANE_NAME]).catch(() => {
					log.debug("herdr pane rename failed — the pane will not be reused");
				});
			} else {
				log.debug(`herdr: reusing pane ${paneId} ("${PANE_NAME}")`);
			}

			// Two-part sentinel — see the file header.
			const uniq = `done-${process.pid}-${Date.now()}`;
			sentinel = `notabene-${uniq}`;
			const command = `cd ${shq(options.cwd)} && ${HANDOFF_ENV}=${shq(options.handoffPath)} `
				+ `${shq(hunkBin)} diff --extension ${shq(extensionDir())}; `
				+ `printf '\\n%s%s\\n' 'notabene-' ${shq(uniq)}`;
			await runHerdr(herdrBin, options.env, ["pane", "run", paneId, command]);
			log.info(`Diff opened in a Herdr pane ("${PANE_NAME}") — switch focus to it.`);
		},

		async waitForDone(options: WaitOptions): Promise<DoneReason> {
			if (paneId === null) throw new ReviewError("herdr-launcher: waitForDone before open");
			// Ctrl-C could have happened back in open (split/rename/run): subscribing
			// below to an ALREADY aborted signal would not fire, and the wait would
			// hang until the timeout.
			if (options.signal?.aborted === true) return "interrupted";

			const child = spawn(herdrBin, [
				"pane", "wait-output", paneId, "--match", sentinel, "--timeout", String(options.timeoutMs),
			], { env: waitEnv, stdio: ["ignore", "pipe", "pipe"] });

			return new Promise((resolve, reject) => {
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
				child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

				// Safety timer on top of herdr's own --timeout.
				const timer = setTimeout(() => {
					child.kill();
					resolve("timeout");
				}, options.timeoutMs + 5000);
				const onAbort = (): void => {
					child.kill();
					resolve("interrupted");
				};
				options.signal?.addEventListener("abort", onAbort, { once: true });

				child.on("error", (error) => reject(new ReviewError(`herdr failed to start: ${error.message}`)));
				child.on("close", (code) => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					if (options.signal?.aborted === true) return; // already resolved as "interrupted"
					// The reply matters more than the exit code: an error can arrive with code 0.
					const reply = parseReply(stdout) ?? parseReply(stderr);
					const message = reply?.error?.message ?? reply?.error?.code ?? "";
					if (/timeout|timed.?out/i.test(message)) {
						resolve("timeout");
						return;
					}
					if (code === 0 && reply?.error === undefined) {
						resolve("viewer-exited");
						return;
					}
					reject(new ReviewError(`herdr pane wait-output: ${message || stderr.trim() || `code ${code ?? "?"}`}`));
				});
			});
		},

		async collect(): Promise<ReviewComment[]> {
			return collectComments(ctx.cwd);
		},
	};
}
