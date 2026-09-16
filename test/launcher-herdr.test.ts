// herdr launcher headless: instead of a real herdr — a stub script replying
// with structured JSON like the herdr pane API does. No live Herdr is needed
// in the tests (there may be no server at all) — rule T5.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { detectEnvironment, herdrLauncher } from "../src/launcher/index.ts";
import type { Launcher } from "../src/launcher/index.ts";

let dir: string;

/** herdr stub: writes its calls to capture.log, replies per the table. */
function stubHerdr(replies: Partial<Record<string, string>>, waitBody = ""): string {
	const path = join(dir, "herdr-stub.sh");
	const lines = [
		"#!/bin/sh",
		// printf, not echo: echo in /bin/sh on macOS interprets \n inside arguments
		`printf '%s\\n' "$*" >> "${join(dir, "capture.log")}"`,
		'case "$1 $2" in',
	];
	const defaults: Record<string, string> = {
		"pane list": '{"id":"x","result":{"panes":[{"id":"p7","label":"other"}]}}',
		"pane split": '{"id":"x","result":{"pane":{"id":"p42"}}}',
		"pane rename": '{"id":"x","result":{}}',
		"pane run": '{"id":"x","result":{}}',
		"pane wait-output": '{"id":"x","result":{"matched":true}}',
	};
	for (const [command, reply] of Object.entries({ ...defaults, ...replies })) {
		if (command === "pane wait-output") {
			lines.push(`  "${command}") ${waitBody} echo '${reply}' ;;`);
		} else {
			lines.push(`  "${command}") echo '${reply}' ;;`);
		}
	}
	lines.push("esac");
	writeFileSync(path, `${lines.join("\n")}\n`);
	chmodSync(path, 0o755);
	return path;
}

function makeLauncher(herdrBin: string): { launcher: Launcher; env: NodeJS.ProcessEnv } {
	const env: NodeJS.ProcessEnv = {
		PATH: "/usr/bin:/bin",
		HERDR_ENV: "1",
		NOTABENE_HERDR: herdrBin,
		NOTABENE_HUNK: "/opt/hunk/bin/hunk",
	};
	return { launcher: herdrLauncher({ detected: detectEnvironment(env), stateDir: join(dir, "state") }), env };
}

async function openDefault(launcher: Launcher, env: NodeJS.ProcessEnv): Promise<void> {
	await launcher.open({
		cwd: dir,
		env,
		handoffPath: join(dir, "handoff.json"),
		label: 'Turn T3 ("fix the balance")',
	});
}

function capture(): string {
	return readFileSync(join(dir, "capture.log"), "utf8");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "notabene-herdr-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("herdr launcher (flow A) on a stub", () => {
	test("normal cycle: split --no-focus → rename → run → wait-output by sentinel", async () => {
		const { launcher, env } = makeLauncher(stubHerdr({}));
		await openDefault(launcher, env);
		assert.equal(await launcher.waitForDone({ timeoutMs: 5000 }), "viewer-exited");

		const log = capture();
		assert.match(log, /pane split --current --direction right --cwd .* --no-focus/);
		assert.match(log, /pane rename p42 notabene\n/);
		// the command in the pane: cd, handoff, hunk by absolute path, our extension
		assert.match(log, /pane run p42 cd '.*' && NOTABENE_HANDOFF='.*handoff\.json' '\/opt\/hunk\/bin\/hunk' diff --extension '.*src\/hunk-ext'/);
		// the sentinel is printed in two parts — the command contains NO whole sentinel
		assert.match(log, /printf '\\n%s%s\\n' 'notabene-' 'done-/);
		assert.doesNotMatch(log, /pane run .*notabene-done-/);
		// while the wait is for the whole one
		assert.match(log, /pane wait-output p42 --match notabene-done-\d+-\d+ --timeout 5000/);
	});

	test("pane reuse by name: split is not called", async () => {
		const { launcher, env } = makeLauncher(stubHerdr({
			"pane list": '{"id":"x","result":{"panes":[{"id":"p9","label":"notabene"}]}}',
		}));
		await openDefault(launcher, env);
		const log = capture();
		assert.doesNotMatch(log, /pane split/);
		assert.doesNotMatch(log, /pane rename/);
		assert.match(log, /pane run p9 /);
	});

	test("a wait-output timeout arrives as timeout, not as an error", async () => {
		const { launcher, env } = makeLauncher(stubHerdr({
			"pane wait-output": '{"id":"x","error":{"code":"timeout","message":"timed out after 100ms"}}',
		}, "sleep 0.05;"));
		await openDefault(launcher, env);
		assert.equal(await launcher.waitForDone({ timeoutMs: 100 }), "timeout");
	});

	test("Ctrl-C interrupts the wait", async () => {
		const { launcher, env } = makeLauncher(stubHerdr({}, "sleep 5;"));
		await openDefault(launcher, env);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		assert.equal(
			await launcher.waitForDone({ timeoutMs: 5000, signal: controller.signal }),
			"interrupted",
		);
	});

	test("Ctrl-C during open (signal already aborted) — no waiting at all", async () => {
		// Subscribing to an ALREADY aborted AbortSignal does not fire, so the wait
		// would hang until the sentinel or the 30-minute safety timer.
		const { launcher, env } = makeLauncher(stubHerdr({}, "sleep 30;"));
		await openDefault(launcher, env);
		const controller = new AbortController();
		controller.abort();
		const started = Date.now();
		assert.equal(
			await launcher.waitForDone({ timeoutMs: 60_000, signal: controller.signal }),
			"interrupted",
		);
		assert.ok(Date.now() - started < 1000, "the return must be immediate");
	});

	test("a split error (herdr server) — a clear ReviewError", async () => {
		const { launcher, env } = makeLauncher(stubHerdr({
			"pane list": '{"id":"x","error":{"code":"server_not_running","message":"no herdr server is running"}}',
			"pane split": '{"id":"x","error":{"code":"server_not_running","message":"no herdr server is running"}}',
		}));
		await assert.rejects(async () => openDefault(launcher, env), /no herdr server/);
	});
});
