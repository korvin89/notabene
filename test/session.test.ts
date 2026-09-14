import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ReviewError } from "../src/io.ts";
import { envSessionSource, pidSessionSource, resolveSession } from "../src/session/index.ts";
import { ancestors } from "../src/session/proc.ts";
import { projectSlug } from "../src/session/transcript.ts";
import type { SessionContext } from "../src/session/types.ts";
import { claudeFixture, fakeProcTable } from "./helpers.ts";

const SID = "7ed463a1-7b85-4820-b063-c9d6db53a697";
const PROJECT = "/Users/test/pet-projects/notabene";

function context(overrides: Partial<SessionContext> & Pick<SessionContext, "claudeDir">): SessionContext {
	return {
		env: {},
		cwd: PROJECT,
		pid: 100,
		proc: fakeProcTable({}),
		...overrides,
	};
}

describe("session source: env level", () => {
	test("takes CLAUDE_CODE_SESSION_ID", () => {
		const fixture = claudeFixture();
		const info = envSessionSource.resolve(
			context({ claudeDir: fixture.claudeDir, env: { CLAUDE_CODE_SESSION_ID: SID } }),
		);

		assert.deepEqual(info, {
			sessionId: SID,
			cwd: PROJECT,
			transcriptPath: null,
			claudePid: null,
			origin: "env",
		});
	});

	test("without the variable yields to the next level", () => {
		const fixture = claudeFixture();
		assert.equal(envSessionSource.resolve(context({ claudeDir: fixture.claudeDir })), null);
	});

	test("cwd comes from the registry: `!ntb` may have been run from a subdirectory", () => {
		const fixture = claudeFixture();
		fixture.session(62678, { pid: 62678, sessionId: SID, cwd: PROJECT, kind: "interactive" });

		const info = envSessionSource.resolve(
			context({
				claudeDir: fixture.claudeDir,
				cwd: `${PROJECT}/src`,
				env: { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PID: "62678" },
			}),
		);

		assert.equal(info?.cwd, PROJECT);
		assert.equal(info?.claudePid, 62678);
	});

	test("a registry entry about another session is ignored", () => {
		const fixture = claudeFixture();
		fixture.session(62678, { pid: 62678, sessionId: "other-session", cwd: "/other" });

		const info = envSessionSource.resolve(
			context({
				claudeDir: fixture.claudeDir,
				env: { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PID: "62678" },
			}),
		);

		assert.equal(info?.cwd, PROJECT);
	});
});

describe("session source: pid-chain level", () => {
	test("walks up the ancestors to the claude process", () => {
		const fixture = claudeFixture();
		fixture.session(52488, { pid: 52488, sessionId: SID, cwd: PROJECT, kind: "interactive" });

		const info = pidSessionSource.resolve(
			context({
				claudeDir: fixture.claudeDir,
				pid: 70001,
				// review(70001) → sh(70000) → claude(52488)
				proc: fakeProcTable({ 70001: 70000, 70000: 52488, 52488: 1 }),
			}),
		);

		assert.equal(info?.sessionId, SID);
		assert.equal(info?.cwd, PROJECT);
		assert.equal(info?.claudePid, 52488);
		assert.equal(info?.origin, "pid");
	});

	test("distinguishes parallel sessions in the same repository", () => {
		const fixture = claudeFixture();
		fixture.session(1001, { pid: 1001, sessionId: "session-A", cwd: PROJECT });
		fixture.session(1002, { pid: 1002, sessionId: "session-B", cwd: PROJECT });

		const resolveFrom = (claudePid: number): string | undefined =>
			pidSessionSource.resolve(
				context({
					claudeDir: fixture.claudeDir,
					pid: 9000,
					proc: fakeProcTable({ 9000: claudePid, [claudePid]: 1 }),
				}),
			)?.sessionId;

		assert.equal(resolveFrom(1001), "session-A");
		assert.equal(resolveFrom(1002), "session-B");
	});

	test("broken JSON in the registry does not stop the walk upward", () => {
		const fixture = claudeFixture();
		fixture.session(70000, "{this is not json");
		fixture.session(52488, { pid: 52488, sessionId: SID, cwd: PROJECT });

		const info = pidSessionSource.resolve(
			context({
				claudeDir: fixture.claudeDir,
				pid: 70001,
				proc: fakeProcTable({ 70001: 70000, 70000: 52488, 52488: 1 }),
			}),
		);

		assert.equal(info?.sessionId, SID);
	});

	test("yields when the registry has no entries", () => {
		const fixture = claudeFixture();
		assert.equal(
			pidSessionSource.resolve(
				context({ claudeDir: fixture.claudeDir, pid: 70001, proc: fakeProcTable({ 70001: 1 }) }),
			),
			null,
		);
	});
});

describe("resolveSession: the chain and the transcript", () => {
	test("env wins over the pid chain", () => {
		const fixture = claudeFixture();
		fixture.session(52488, { pid: 52488, sessionId: "from-registry", cwd: PROJECT });

		const info = resolveSession(
			context({
				claudeDir: fixture.claudeDir,
				env: { CLAUDE_CODE_SESSION_ID: SID },
				pid: 70001,
				proc: fakeProcTable({ 70001: 52488, 52488: 1 }),
			}),
		);

		assert.equal(info.sessionId, SID);
		assert.equal(info.origin, "env");
	});

	test("the transcript is found via the project slug", () => {
		const fixture = claudeFixture();
		const path = fixture.transcript(PROJECT, SID);

		const info = resolveSession(
			context({ claudeDir: fixture.claudeDir, env: { CLAUDE_CODE_SESSION_ID: SID } }),
		);

		assert.equal(info.transcriptPath, path);
	});

	test("the transcript is found by scanning when the slug does not match", () => {
		const fixture = claudeFixture();
		const path = fixture.transcript("/a/totally/different/path", SID);

		const info = resolveSession(
			context({ claudeDir: fixture.claudeDir, env: { CLAUDE_CODE_SESSION_ID: SID } }),
		);

		assert.equal(info.transcriptPath, path);
	});

	test("no transcript is not an error, just null (T4 degrades to current)", () => {
		const fixture = claudeFixture();
		const info = resolveSession(
			context({ claudeDir: fixture.claudeDir, env: { CLAUDE_CODE_SESSION_ID: SID } }),
		);

		assert.equal(info.transcriptPath, null);
	});

	test("nothing to determine the session with — a clear error", () => {
		const fixture = claudeFixture();
		assert.throws(
			() => resolveSession(context({ claudeDir: fixture.claudeDir })),
			(error: unknown) => error instanceof ReviewError && /determine the Claude Code session/.test(error.message),
		);
	});
});

describe("helpers", () => {
	test("project slug — every non-alphanumeric becomes a hyphen", () => {
		assert.equal(
			projectSlug("/Users/alaev89/Desktop/pet-projects/notabene"),
			"-Users-alaev89-Desktop-pet-projects-notabene",
		);
		assert.equal(projectSlug("/tmp/a.b_c"), "-tmp-a-b-c");
	});

	test("the ancestor walk does not loop", () => {
		const chain = ancestors(fakeProcTable({ 10: 20, 20: 10 }), 10);
		assert.deepEqual(chain, [10, 20]);
	});

	test("the ancestor walk is depth-limited", () => {
		const parents: Record<number, number> = {};
		for (let pid = 1000; pid < 1100; pid += 1) parents[pid] = pid + 1;
		assert.equal(ancestors(fakeProcTable(parents), 1000, 5).length, 5);
	});
});
