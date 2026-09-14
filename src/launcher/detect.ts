// Environment detection for launcher selection (ARCHITECTURE.md §5, DECISIONS.md D4).
//
// We only check environment variables — no process spawning: detection runs on
// every `!ntb` and has to be free. Whether the chosen strategy actually works
// is discovered on the first call anyway (kitty returns an exit code, herdr —
// structured JSON with an error).

import type { LauncherName } from "./types.ts";

export interface LauncherAvailability {
	name: LauncherName;
	available: boolean;
	/** human-readable explanation for `dump env` and first-run hints */
	reason: string;
}

export interface KittyAvailability extends LauncherAvailability {
	/** control socket address for `kitty @ --to` */
	listenOn: string | null;
	listenOnFrom: "KITTY_LISTEN_ON" | "KITTY_PID" | null;
	/** the terminal is kitty even if remote control is off (for the hint) */
	inKitty: boolean;
}

export interface LauncherEnvironment {
	herdr: LauncherAvailability;
	kitty: KittyAvailability;
	manual: LauncherAvailability;
}

export function detectEnvironment(env: NodeJS.ProcessEnv): LauncherEnvironment {
	return { herdr: detectHerdr(env), kitty: detectKitty(env), manual: detectManual() };
}

function detectHerdr(env: NodeJS.ProcessEnv): LauncherAvailability {
	const flag = env["HERDR_ENV"];
	const available = flag !== undefined && flag !== "" && flag !== "0";
	return {
		name: "herdr",
		available,
		reason: available
			? `HERDR_ENV=${flag}: Claude Code is running in a Herdr pane`
			: "no HERDR_ENV: not in Herdr",
	};
}

function detectKitty(env: NodeJS.ProcessEnv): KittyAvailability {
	// kitty itself exports KITTY_LISTEN_ON to child processes when the config has
	// `listen_on` (verified 2026-09-13). Building the address from KITTY_PID is a
	// safety net in case the variable is somehow missing.
	const inKitty = env["KITTY_WINDOW_ID"] !== undefined || env["TERM"] === "xterm-kitty"
		|| env["KITTY_PID"] !== undefined;

	const listenOn = env["KITTY_LISTEN_ON"];
	if (listenOn !== undefined && listenOn !== "") {
		return {
			name: "kitty",
			available: true,
			listenOn,
			listenOnFrom: "KITTY_LISTEN_ON",
			inKitty: true,
			reason: `KITTY_LISTEN_ON=${listenOn}`,
		};
	}

	const pid = env["KITTY_PID"];
	if (pid !== undefined && pid !== "" && Number.parseInt(pid, 10) > 0) {
		return {
			name: "kitty",
			available: true,
			listenOn: `unix:/tmp/kitty-${pid}`,
			listenOnFrom: "KITTY_PID",
			inKitty: true,
			reason: `no KITTY_LISTEN_ON, address built from KITTY_PID=${pid} (unverified)`,
		};
	}

	return {
		name: "kitty",
		available: false,
		listenOn: null,
		listenOnFrom: null,
		inKitty,
		// The most common first-run case: kitty is there, but the two config lines are not.
		reason: inKitty
			? "kitty without remote control: ~/.config/kitty/kitty.conf needs "
				+ "`allow_remote_control socket-only` and `listen_on unix:/tmp/kitty`, "
				+ "then a full kitty restart"
			: "not in kitty",
	};
}

function detectManual(): LauncherAvailability {
	return { name: "manual", available: true, reason: "fallback path, always works" };
}
