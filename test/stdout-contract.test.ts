// Safety net for the "stdout is sacred" invariant (ARCHITECTURE.md §3.1, §6):
// writing to stdout is allowed only through emit() from src/io.ts. This test is
// cheaper than catching a stray console.log in Claude's context on a live review.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ALLOWED = new Set(["io.ts"]);

function sourceFiles(): string[] {
	return readdirSync(SRC, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
}

// The whole console namespace except warn/error (those write to stderr): log,
// info, dir, table are stdout, but so are debug/group/count/timeLog — and those
// are easy to miss when listing by hand. Plus file descriptor 1 directly.
const STDOUT_WRITE = /\bprocess\.stdout\b|\bconsole\.(?!warn\b|error\b)[a-zA-Z]+\b|\bwriteSync\(\s*1\b/;

test("only src/io.ts writes to stdout", () => {
	const offenders: string[] = [];
	for (const file of sourceFiles()) {
		if (ALLOWED.has(file.slice(SRC.length + 1))) continue;
		const source = readFileSync(file, "utf8");
		for (const [index, line] of source.split("\n").entries()) {
			if (line.trimStart().startsWith("//")) continue;
			if (STDOUT_WRITE.test(line)) {
				offenders.push(`${file.slice(SRC.length + 1)}:${index + 1}: ${line.trim()}`);
			}
		}
	}
	assert.deepEqual(offenders, [], `direct stdout write outside io.ts:\n${offenders.join("\n")}`);
});

test("the guard catches every stdout channel and lets stderr channels through", () => {
	for (const line of [
		`console.log("x")`,
		`console.debug("x")`,
		`console.group("x")`,
		`console.table(rows)`,
		`process.stdout.write("x")`,
		`writeSync(1, "x")`,
	]) {
		assert.ok(STDOUT_WRITE.test(line), `must be caught: ${line}`);
	}
	for (const line of [`console.warn("x")`, `console.error("x")`, `process.stderr.write("x")`]) {
		assert.ok(!STDOUT_WRITE.test(line), `must not count as a violation: ${line}`);
	}
});

test("the sources did not forget the stderr diagnostics channel", () => {
	const io = readFileSync(join(SRC, "io.ts"), "utf8");
	assert.match(io, /process\.stderr\.write/);
});
