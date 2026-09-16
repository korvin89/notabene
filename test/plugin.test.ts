// Reading Claude Code's plugin record (src/plugin.ts, ARCHITECTURE.md §7.2).
//
// The file is an internal format we do not own, so every test here is really the
// same test: an unfamiliar shape must read as "unknown", never as a throw. An
// `ntb update` that dies because a state file changed shape would be a worse
// failure than the drift it was trying to report.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { compareVersions, installedPluginVersion } from "../src/plugin.ts";

const cleanups: string[] = [];
after(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** A fake `<claudeDir>` holding whatever `installed_plugins.json` we want. */
function claudeDir(body?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "notabene-plugin-"));
	cleanups.push(dir);
	if (body !== undefined) {
		mkdirSync(join(dir, "plugins"), { recursive: true });
		writeFileSync(join(dir, "plugins", "installed_plugins.json"), body);
	}
	return dir;
}

function record(plugins: unknown): string {
	return claudeDir(JSON.stringify({ version: 2, plugins }));
}

describe("installedPluginVersion", () => {
	test("reads the version Claude Code recorded", () => {
		const dir = record({ "ntb@notabene": [{ scope: "user", version: "0.3.0" }] });
		assert.equal(installedPluginVersion(dir), "0.3.0");
	});

	test("several scopes hold the same plugin — the newest wins", () => {
		const dir = record({
			"ntb@notabene": [
				{ scope: "project", version: "0.2.0" },
				{ scope: "user", version: "0.10.0" },
				{ scope: "local", version: "0.9.0" },
			],
		});
		// 0.10.0, not 0.9.0: the comparison is numeric, not lexicographic
		assert.equal(installedPluginVersion(dir), "0.10.0");
	});

	test("another plugin installed, ours is not", () => {
		const dir = record({ "wiki@datalens-marketplace": [{ scope: "user", version: "1.4.2" }] });
		assert.equal(installedPluginVersion(dir), null);
	});

	test("no file at all — the usual case for someone who never added the plugin", () => {
		assert.equal(installedPluginVersion(claudeDir()), null);
	});

	test("corrupt or unfamiliar shapes read as unknown, never throw", () => {
		for (const body of [
			"{ not json",
			"null",
			"[]",
			'{"version":2}',
			'{"plugins":[]}',
			'{"plugins":{"ntb@notabene":"0.3.0"}}',
			'{"plugins":{"ntb@notabene":[]}}',
			'{"plugins":{"ntb@notabene":[{"scope":"user"}]}}',
			'{"plugins":{"ntb@notabene":[{"version":42}]}}',
			'{"plugins":{"ntb@notabene":[null]}}',
		]) {
			assert.equal(installedPluginVersion(claudeDir(body)), null, `on ${body}`);
		}
	});
});

describe("compareVersions", () => {
	test("orders by number, not by string", () => {
		assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
		assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
		assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
	});

	test("a missing part is zero, so 0.3 and 0.3.0 are the same release", () => {
		assert.equal(compareVersions("0.3", "0.3.0"), 0);
		assert.ok(compareVersions("0.3", "0.3.1") < 0);
	});

	test("garbage never looks newer", () => {
		assert.ok(compareVersions("what", "0.0.1") < 0);
		assert.equal(compareVersions("what", "nonsense"), 0);
	});
});
