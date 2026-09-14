// kitty launcher headless: instead of a real kitty — a stub script that fakes
// `launch` (prints the window id) and `ls --match id:N` (its exit code says
// whether the window is alive). Rule T5: the interactive hunk itself never runs.
//
// Waiting is done by polling, not by `--wait-for-child-to-exit`: on a live
// machine the client with that flag never returns (see the header of
// src/launcher/kitty.ts).

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { detectEnvironment, kittyLauncher } from "../src/launcher/index.ts";
import type { Launcher } from "../src/launcher/index.ts";

let dir: string;

/** "Window alive" flag file: the test creates and removes it, the stub watches it. */
function alivePath(): string {
	return join(dir, "window-alive");
}

function stubKitty(options: { launchOutput?: string; launchCode?: number } = {}): string {
	const path = join(dir, "kitty-stub.sh");
	writeFileSync(
		path,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> "${join(dir, "args.txt")}"`,
			'case "$*" in',
			`  *" launch "*) printf '%s\\n' '${options.launchOutput ?? "42"}'; exit ${options.launchCode ?? 0} ;;`,
			`  *" ls --match id:"*) [ -f "${alivePath()}" ] ;;`,
			"esac",
		].join("\n"),
	);
	chmodSync(path, 0o755);
	return path;
}

function makeLauncher(kittyBin: string): { launcher: Launcher; env: NodeJS.ProcessEnv } {
	const env: NodeJS.ProcessEnv = {
		PATH: "/usr/bin:/bin",
		HOME: "/home/test",
		KITTY_LISTEN_ON: "unix:/tmp/kitty-777",
		NOTABENE_KITTY: kittyBin,
		NOTABENE_HUNK: "/opt/hunk/bin/hunk",
	};
	return { launcher: kittyLauncher({ detected: detectEnvironment(env), cwd: dir }), env };
}

async function openDefault(launcher: Launcher, env: NodeJS.ProcessEnv): Promise<void> {
	await launcher.open({
		cwd: dir,
		env,
		handoffPath: join(dir, "handoff.json"),
		label: 'Turn T3 ("fix the balance")',
	});
}

/** The extension creates the mirror on load — that is how we see the viewer started. */
function pretendExtensionLoaded(): void {
	mkdirSync(join(dir, ".claude", "reviews"), { recursive: true });
	writeFileSync(join(dir, ".claude", "reviews", "notes.json"), "[]\n");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "notabene-kitty-"));
	writeFileSync(alivePath(), "");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("kitty launcher (flow B) on a stub command", () => {
	test("launch: all ARCHITECTURE.md §5.3 pitfalls in the arguments, waiting without --wait-for-child-to-exit", async () => {
		const { launcher, env } = makeLauncher(stubKitty());
		await openDefault(launcher, env);

		const args = readFileSync(join(dir, "args.txt"), "utf8");
		assert.match(args, /^@ --to unix:\/tmp\/kitty-777 launch --type=tab /);
		// the viewer — by absolute path, not via kitty's PATH
		assert.match(args, /\/opt\/hunk\/bin\/hunk diff --extension .*src\/hunk-ext/);
		// PATH/HOME/handoff are passed explicitly
		assert.match(args, /--env PATH=\/usr\/bin:\/bin/);
		assert.match(args, /--env HOME=\/home\/test/);
		assert.match(args, new RegExp(`--env NOTABENE_HANDOFF=${join(dir, "handoff.json")}`));
		// the turn label in the tab title
		assert.match(args, /notabene: Turn T3/);
		// the flag that hangs the client forever on this machine is not used
		assert.doesNotMatch(args, /--wait-for-child-to-exit/);
	});

	test("normal cycle: while the window is alive — wait; gone — viewer-exited", async () => {
		const { launcher, env } = makeLauncher(stubKitty());
		pretendExtensionLoaded();
		await openDefault(launcher, env);
		setTimeout(() => rmSync(alivePath(), { force: true }), 300);

		assert.equal(await launcher.waitForDone({ timeoutMs: 10_000 }), "viewer-exited");
		assert.match(readFileSync(join(dir, "args.txt"), "utf8"), /ls --match id:42/);
	});

	test("timeout: the window never closed", async () => {
		const { launcher, env } = makeLauncher(stubKitty());
		pretendExtensionLoaded();
		await openDefault(launcher, env);
		const started = Date.now();
		assert.equal(await launcher.waitForDone({ timeoutMs: 300 }), "timeout");
		assert.ok(Date.now() - started < 5000, "the wait must be cut off by the timer");
	});

	test("Ctrl-C interrupts the wait without waiting for the next poll", async () => {
		const { launcher, env } = makeLauncher(stubKitty());
		pretendExtensionLoaded();
		await openDefault(launcher, env);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		assert.equal(
			await launcher.waitForDone({ timeoutMs: 10_000, signal: controller.signal }),
			"interrupted",
		);
		assert.ok(Date.now() - started < 900, "Ctrl-C must not wait a whole poll tick");
	});

	test("the kitty client temporarily not responding — keep waiting instead of failing the review", async () => {
		// The socket may have been recreated (kitty restart). The comments are
		// already typed in, and losing them over an unresponsive client is not ok.
		const stub = stubKitty();
		const { launcher, env } = makeLauncher(stub);
		pretendExtensionLoaded();
		await openDefault(launcher, env);

		const saved = readFileSync(stub, "utf8");
		rmSync(stub, { force: true }); // no client: execFile fails with ENOENT
		setTimeout(() => {
			writeFileSync(stub, saved);
			chmodSync(stub, 0o755);
			rmSync(alivePath(), { force: true }); // and now the window has closed too
		}, 1500);

		assert.equal(await launcher.waitForDone({ timeoutMs: 10_000 }), "viewer-exited");
	});

	test("the tab closed instantly and there is no extension trace — the viewer did not start", async () => {
		const { launcher, env } = makeLauncher(stubKitty());
		await openDefault(launcher, env);
		rmSync(alivePath(), { force: true });
		await assert.rejects(
			async () => launcher.waitForDone({ timeoutMs: 5000 }),
			/viewer did not start.*npm install/s,
		);
	});

	test("launch returned no window id — a clear error", async () => {
		const { launcher, env } = makeLauncher(stubKitty({ launchOutput: "no matching window", launchCode: 1 }));
		await assert.rejects(async () => openDefault(launcher, env), /did not open a tab/);
	});

	test("kitty unavailable (no socket) — open fails with the detection reason", async () => {
		const launcher = kittyLauncher({ detected: detectEnvironment({}), cwd: dir });
		await assert.rejects(
			async () =>
				launcher.open({ cwd: dir, env: {}, handoffPath: join(dir, "handoff.json"), label: "x" }),
			/kitty-launcher unavailable/,
		);
	});

	test("collect reads the comment mirror from the review root", async () => {
		const { launcher } = makeLauncher(stubKitty());
		const reviews = join(dir, ".claude", "reviews");
		mkdirSync(reviews, { recursive: true });
		writeFileSync(
			join(reviews, "notes.json"),
			JSON.stringify([
				{ id: "user:1", source: "user", file: "a.txt", side: "new", oldRange: null, newRange: [2, 4], body: "[b] broken" },
			]),
		);
		const comments = await launcher.collect();
		assert.equal(comments.length, 1);
		assert.equal(comments[0]?.type, "blocker");
		assert.equal(comments[0]?.startLine, 2);
		assert.equal(comments[0]?.endLine, 4);
	});
});
