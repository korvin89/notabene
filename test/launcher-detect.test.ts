import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LAUNCHER_CHAIN, detectEnvironment, selectLauncher } from "../src/launcher/index.ts";

// Selection never touches the state directory (it only matters for collection),
// but the adapter needs one — a path that does not exist keeps that honest.
const STATE = "/nonexistent/notabene-state";

describe("environment detection", () => {
	test("HERDR_ENV=1 — we are in a Herdr pane", () => {
		const env = detectEnvironment({ HERDR_ENV: "1" });
		assert.equal(env.herdr.available, true);
		assert.match(env.herdr.reason, /Herdr/);
	});

	test("HERDR_ENV=0 and an empty string do not count", () => {
		assert.equal(detectEnvironment({ HERDR_ENV: "0" }).herdr.available, false);
		assert.equal(detectEnvironment({ HERDR_ENV: "" }).herdr.available, false);
	});

	test("KITTY_LISTEN_ON gives the socket address as is", () => {
		const env = detectEnvironment({ KITTY_LISTEN_ON: "unix:/tmp/kitty-62314" });
		assert.equal(env.kitty.available, true);
		assert.equal(env.kitty.listenOn, "unix:/tmp/kitty-62314");
		assert.equal(env.kitty.listenOnFrom, "KITTY_LISTEN_ON");
	});

	test("without KITTY_LISTEN_ON the address is built from KITTY_PID (safety net)", () => {
		const env = detectEnvironment({ KITTY_PID: "62314" });
		assert.equal(env.kitty.available, true);
		assert.equal(env.kitty.listenOn, "unix:/tmp/kitty-62314");
		assert.equal(env.kitty.listenOnFrom, "KITTY_PID");
	});

	test("kitty without remote control: explain the two lines in kitty.conf", () => {
		const env = detectEnvironment({ TERM: "xterm-kitty" });
		assert.equal(env.kitty.available, false);
		assert.equal(env.kitty.listenOn, null);
		assert.match(env.kitty.reason, /kitty\.conf/);
	});

	test("bare environment: only manual is available", () => {
		const env = detectEnvironment({});
		assert.equal(env.herdr.available, false);
		assert.equal(env.kitty.available, false);
		assert.equal(env.manual.available, true);
	});
});

describe("launcher selection", () => {
	test("chain order — herdr → kitty → manual (DECISIONS.md D4)", () => {
		assert.deepEqual([...LAUNCHER_CHAIN], ["herdr", "kitty", "manual"]);
	});

	test("Herdr overrides kitty", () => {
		const launcher = selectLauncher({
			env: { HERDR_ENV: "1", KITTY_LISTEN_ON: "unix:/tmp/kitty-1" },
			stateDir: STATE,
		});
		assert.equal(launcher.name, "herdr");
		assert.equal(launcher.blocking, true);
	});

	test("without Herdr, kitty is chosen", () => {
		const launcher = selectLauncher({ env: { KITTY_LISTEN_ON: "unix:/tmp/kitty-1" }, stateDir: STATE });
		assert.equal(launcher.name, "kitty");
		assert.equal(launcher.blocking, true);
	});

	test("when nothing is available — manual, and it is non-blocking (flow C — two commands)", () => {
		const launcher = selectLauncher({ env: {}, stateDir: STATE });
		assert.equal(launcher.name, "manual");
		assert.equal(launcher.blocking, false);
	});

	test("--launcher overrides detection", () => {
		const launcher = selectLauncher({ env: { HERDR_ENV: "1" }, stateDir: STATE, force: "manual" });
		assert.equal(launcher.name, "manual");
	});

	test("a non-blocking launcher answers detached immediately", async () => {
		const launcher = selectLauncher({ env: {}, stateDir: STATE });
		assert.equal(await launcher.waitForDone({ timeoutMs: 1 }), "detached");
	});

	test("waitForDone before open — a programming error, not a silent wait", async () => {
		const launcher = selectLauncher({ env: { HERDR_ENV: "1" }, stateDir: STATE });
		await assert.rejects(async () => launcher.waitForDone({ timeoutMs: 10 }), /before open/);
	});
});
