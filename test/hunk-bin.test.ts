// How the flow C hint spells our CLI (src/hunk/bin.ts).
//
// The hint is a line the user types in a second terminal, so getting it wrong is
// not cosmetic: a bare `ntb` when PATH holds someone else's `ntb` would run the
// wrong program against this repository's prepared review.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ntbBinPath, ntbCommand } from "../src/hunk/bin.ts";

const WORK = mkdtempSync(join(tmpdir(), "notabene-bin-"));
after(() => rmSync(WORK, { recursive: true, force: true }));

/** A PATH directory holding one entry named `ntb`. */
function pathWith(name: string, make: (target: string) => void): string {
	const dir = join(WORK, name);
	mkdirSync(dir, { recursive: true });
	make(join(dir, "ntb"));
	return dir;
}

describe("ntbCommand", () => {
	test("bare `ntb` when PATH resolves to this very wrapper", () => {
		// Exactly what install.sh creates: a symlink into a bin directory.
		const dir = pathWith("ours", (target) => symlinkSync(ntbBinPath(), target));

		assert.equal(ntbCommand({ PATH: dir }), "ntb");
	});

	test("the absolute path when another ntb shadows ours", () => {
		const dir = pathWith("stranger", (target) => {
			writeFileSync(target, "#!/bin/sh\necho not ours\n");
			chmodSync(target, 0o755);
		});

		assert.equal(ntbCommand({ PATH: dir }), ntbBinPath());
	});

	test("the absolute path when PATH has no ntb at all — a development checkout", () => {
		assert.equal(ntbCommand({ PATH: join(WORK, "empty") }), ntbBinPath());
		assert.equal(ntbCommand({}), ntbBinPath());
	});

	test("a broken symlink does not throw — it falls back to the absolute path", () => {
		const dir = pathWith("broken", (target) => symlinkSync(join(WORK, "gone"), target));

		assert.equal(ntbCommand({ PATH: dir }), ntbBinPath());
	});
});
