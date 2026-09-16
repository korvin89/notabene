// Launcher selection along the chain herdr → kitty → manual (DECISIONS.md D4, D6).
//
// herdr — flow A (./herdr.ts), kitty — flow B (./kitty.ts), manual — flow C
// (./manual.ts). Shared comment collection — src/hunk/notes.ts (collectComments).

import { log } from "../io.ts";
import { detectEnvironment } from "./detect.ts";
import { herdrLauncher } from "./herdr.ts";
import { kittyLauncher } from "./kitty.ts";
import { manualLauncher } from "./manual.ts";
import type { Launcher, LauncherContext, LauncherName } from "./types.ts";

export { detectEnvironment } from "./detect.ts";
export type { KittyAvailability, LauncherAvailability, LauncherEnvironment } from "./detect.ts";
export type { DoneReason, Launcher, LauncherContext, LauncherName, OpenOptions, WaitOptions } from "./types.ts";

/** Probe order. `manual` closes the chain and is always available. */
export const LAUNCHER_CHAIN: readonly LauncherName[] = ["herdr", "kitty", "manual"];

/**
 * After this long Claude Code stops waiting for a `!` command and detaches it
 * ("moved to the background"). Measured by probe 3, docs/spike-tty.md.
 *
 * The process is NOT killed: the viewer stays open, and the batch still reaches
 * Claude as a background-task completion notification. So the constant exists
 * not to interrupt anything but to warn the user that this is normal.
 */
export const BANG_DETACH_MS = 120 * 1000;

/**
 * 4 hours (ARCHITECTURE.md §5.5) — protection against a viewer left open and
 * forgotten. Deliberately larger than BANG_DETACH_MS: cutting a review short at
 * minute two is worse than living through the detach, and the detach itself
 * does not hinder the review.
 *
 * Was 30 minutes until 2026-09-16, when a live run expired mid-review: expiry
 * exits with empty stdout, which drops delivery back to a manual `ntb collect`
 * and therefore back to needing a human message — the exact failure the agent-run
 * flow exists to remove. The old value was calibrated for `!ntb`, where the
 * process held the user's command hostage; run from the Bash tool it holds
 * nothing, the agent is asleep, and waiting is free. The remaining cost of a long
 * wait is that a forgotten viewer keeps `ensureNoPending` refusing new reviews
 * until someone runs `collect`.
 */
export const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export { herdrLauncher } from "./herdr.ts";
export { kittyLauncher } from "./kitty.ts";
export { manualLauncher } from "./manual.ts";

const FACTORIES: Record<LauncherName, (ctx: LauncherContext) => Launcher> = {
	herdr: herdrLauncher,
	kitty: kittyLauncher,
	manual: manualLauncher,
};

export interface SelectOptions {
	env?: NodeJS.ProcessEnv;
	/** review state directory — where the handoff and the comment mirror live (D30) */
	stateDir: string;
	/** forced choice (`--launcher`); detection is ignored in that case */
	force?: LauncherName;
}

/**
 * `ntb open` — an explicit request to open the viewer in this terminal:
 * the detection chain is not consulted. The single point where the core needs
 * a concrete fallback adapter — so that run.ts does not name it directly.
 */
export function explicitOpenLauncher(options: SelectOptions): Launcher {
	return manualLauncher({
		detected: detectEnvironment(options.env ?? {}),
		stateDir: options.stateDir,
	});
}

export function selectLauncher(options: SelectOptions): Launcher {
	const detected = detectEnvironment(options.env ?? {});
	const ctx: LauncherContext = { detected, stateDir: options.stateDir };

	if (options.force !== undefined) {
		const availability = detected[options.force];
		if (!availability.available) {
			log.warn(`launcher ${options.force} forced even though detection is against it: ${availability.reason}`);
		}
		return FACTORIES[options.force](ctx);
	}

	for (const name of LAUNCHER_CHAIN) {
		const availability = detected[name];
		if (availability.available) {
			log.debug(`launcher: ${name} (${availability.reason})`);
			// Polite first-run hint (ARCHITECTURE.md §5.3): we are in kitty, but
			// remote control is not set up — explain why flow B beats two commands.
			if (name === "manual" && detected.kitty.inKitty && !detected.kitty.available) {
				log.info(
					`One command instead of two is possible in this very kitty: ${detected.kitty.reason}. `
						+ "For now continuing with two steps (open/collect).",
				);
			}
			return FACTORIES[name](ctx);
		}
		log.debug(`launcher: ${name} skipped — ${availability.reason}`);
	}

	// Unreachable: manual is always available. Kept so this is visible from the code.
	return manualLauncher(ctx);
}
