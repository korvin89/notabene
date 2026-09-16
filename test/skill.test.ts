// The skill's version floor is wired to release-please (ARCHITECTURE.md §7.2).
//
// The skill tells the agent that a CLI older than the version named at the top of
// SKILL.md is the likely cause of a usage error. That is only true while the
// number keeps itself current — by hand it would rot within two releases and then
// misdiagnose every failure. So the number is maintained by release-please, and
// this test is the guard on the wiring: the annotation, the path in the config,
// and the two versions agreeing right now.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

function repoFile(name: string): string {
	return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
}

const SKILL_PATH = ".claude-plugin/skills/review/SKILL.md";

/** The line release-please rewrites: an annotation and a semver on one line. */
const FLOOR = /^(?=.*x-release-please-version).*?(\d+\.\d+\.\d+).*$/m;

describe("the skill's version floor", () => {
	test("SKILL.md carries an annotated version line", () => {
		const match = FLOOR.exec(repoFile(SKILL_PATH));
		assert.ok(match, "SKILL.md must name a version on a line marked x-release-please-version");
	});

	test("release-please is told to update that file", () => {
		const config = JSON.parse(repoFile("release-please-config.json")) as {
			packages: Record<string, { "extra-files"?: { type?: string; path?: string }[] }>;
		};
		const extras = config.packages["."]?.["extra-files"] ?? [];
		const entry = extras.find((file) => file.path === SKILL_PATH);
		assert.ok(entry, `${SKILL_PATH} must be listed in extra-files, or the floor stops moving`);
		// `generic` is the updater that honours the inline annotation; any other
		// type would silently leave the line alone.
		assert.equal(entry.type, "generic");
	});

	test("the floor matches this release — they move together or not at all", () => {
		const floor = FLOOR.exec(repoFile(SKILL_PATH))?.[1];
		const version = (JSON.parse(repoFile("package.json")) as { version: string }).version;
		assert.equal(
			floor,
			version,
			"the skill's floor drifted from package.json: the release-please wiring is broken, "
				+ "or someone edited one of them by hand",
		);
	});
});
