# Agent field notes

`notabene` — the `ntb` CLI: shows the Claude Code diff in the hunk viewer,
collects inline comments and prints them as a batch to stdout, from where the
text lands in the agent's context. TypeScript, Node 22 with no build step, macOS.

## Where to look

| Need | File |
|---|---|
| How it all works: modules, contracts, formats, invariants | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Why it is this way, what was already tried and rejected | [DECISIONS.md](DECISIONS.md) |
| How to use it, flags, user-facing limitations | [README.md](README.md) |
| Experiment protocols (hunk, tuicr, TTY under `!`, kitty) | [docs/](docs/) |
| The probe scripts those protocols ran | [scripts/](scripts/) |
| Post-MVP candidate directions and positioning | [plans/roadmap.md](plans/roadmap.md) |
| Known defects we chose not to fix yet | [plans/known-gaps.md](plans/known-gaps.md) |
| Batch and JSON-copy format | ARCHITECTURE.md §3 |
| Claude Code formats (sessions, transcript, file-history) | ARCHITECTURE.md §4 |
| The three launch flows and the kitty/herdr pitfalls | ARCHITECTURE.md §5 |
| The two entry points and who owns the process | ARCHITECTURE.md §5.6 |
| How it is installed and updated | ARCHITECTURE.md §7 |
| How versions, tags and the changelog work | ARCHITECTURE.md §7.1 |
| The plugin channel — how `/ntb` reaches the user | ARCHITECTURE.md §7.2 |

Code map — ARCHITECTURE.md §2 (the `src/` tree with each file's purpose).

## Commands

```sh
npm test
npm run typecheck        # tsc --noEmit
./ntb dump current       # working-tree diff as JSON
./ntb dump turns         # per-turn changesets
./ntb dump session       # how the session was resolved
./ntb dump env           # what the launcher detection saw
./ntb update --check     # is there a newer release (managed installs only)
```

Env overrides for tests and nonstandard environments: `NOTABENE_HUNK`,
`NOTABENE_KITTY`, `NOTABENE_HERDR`, `NOTABENE_TTY=1|0`,
`CLAUDE_CONFIG_DIR`; the handoff path is passed to the viewer and the extension
via `NOTABENE_HANDOFF` (ARCHITECTURE.md §3.3).

## What must not be broken

The full list with its guards — ARCHITECTURE.md §6. In short:

1. **Only `emit()` from `src/io.ts` writes to stdout.** Everything else is
   `log.*` to stderr. Otherwise diagnostics leak into the agent's context as
   part of the task.
2. **Zero runtime dependencies**, except the pinned `hunkdiff@0.22.0`.
3. **No build step**: syntax must be erasable (`erasableSyntaxOnly` — no
   `enum`/`namespace`), imports carry the `.ts` extension.
4. **`src/hunk-ext/index.ts` is self-contained**: the hunk loader executes it,
   our modules are unavailable to it. Schemas there are duplicated structurally;
   the canon is `src/hunk/handoff.ts` and `src/hunk/notes.ts`.
5. **Exit codes** — only from `EXIT` in `src/io.ts` (0/1/2/3/130); the single
   exception is 127 from the sh wrapper `ntb` when `PATH` has no node.

## Pitfalls of this repository

- **Tests that run `./ntb` must set `cwd`.** Without it a test once ate a
  developer's real unfinished review: pending cleared, the batch gone into a
  swallowed stdout. `test/cli.test.ts` has a shared temp directory for this.
- **The interactive TUI is never launched in tests.** The viewer is replaced by
  a stub via `NOTABENE_HUNK`; kitty and herdr — by stub scripts; `npm` in the
  installer tests — likewise (a real `npm ci` would pull ~100 MB every run).
- **This repository is a development checkout, not an install.** It has no
  `.managed-install` marker, so `ntb update` refuses to act on it — deliberately
  (ARCHITECTURE.md §7). Don't add the marker to make a manual test pass.
- **Do not run a bare `./ntb` anywhere while working here** — only `dump` and
  `collect` are safe. Changing directory does not protect you: the review root
  comes from the *session's* cwd, not the process's (`run.ts` →
  `reviewRoot(session.cwd)`), so a run from `/tmp` still prepares a review of
  this repository. It opens a viewer and blocks the next `!ntb` with "unfinished
  review"; the leftover `pending.json` and the megabyte-sized `handoff.json` land
  in `~/.claude/notabene/<slug>/`, not in the working tree (D30). Recovery:
  `./ntb collect` — it dismisses an empty session silently and prints nothing to
  stdout. (Learned the hard way on 2026-09-14, from a `/tmp` run believed to be
  harmless.)
- **One writer per tree.** Don't give the reviewer subagent write access
  (DECISIONS.md D24).
- **Do not rewrite the spike docs in `docs/` or the probes in `scripts/`** —
  together they are one experiment record; outdated statements get an in-place
  amendment (D23), never a silent edit.
- **Verify live, not by documentation.** Three times in a row the documented
  behavior turned out wrong: `/dev/tty` under `!` (D3), kitty's
  `--wait-for-child-to-exit` (D5), the `--no-update-check` flag (D20).

## Historical markers

Comments and tests carry `T1`–`T7` markers — tickets of the original development
plan (spike gates, skeleton, diff sources, viewer, delivery, integration). The
plan itself is closed and folded into DECISIONS.md; the markers remain as
pointers to "when and in what context this appeared".

## Working rules

- Changing behavior or reversing an accepted decision — consider a DECISIONS.md
  entry, but the default is **no**: the log takes only what would change a future
  decision. The `/decision` skill (`.claude/skills/decision/`) has the test and
  the format; renames, moves and backlogs fail it. Old entries are not rewritten
  retroactively once the repository is pushed.
- Changing the design — update ARCHITECTURE.md in the same commit.
- Commit messages are Conventional Commits, scoped by area where it helps —
  `cli`, `tui` (the viewer: extension, handoff, keys), `diff`, `session`,
  `launcher`, `delivery`, `install`, `update`: `feat(diff): …`, `fix(tui): …`,
  `ci: …`. They are the release input, not
  decoration — `feat` moves the minor, `fix`/`perf` the patch, a `!` or a
  `BREAKING CHANGE:` footer the minor while we are below 1.0, and everything else
  ships without a release (ARCHITECTURE.md §7.1). Pull requests are squash-merged,
  so the *title* is what release-please reads.
- `CHANGELOG.md` is generated by release-please — never edit it by hand, and do
  not bump `version` in `package.json` either; the release pull request owns both.
- All project documentation (README, ARCHITECTURE, DECISIONS, docs/, this file)
  and code comments are written in English — including new DECISIONS entries
  and in-place amendments to spike docs. CLI output and the stdout batch are in
  English as well.
- Before committing: `npm test` and `npm run typecheck` green. The same two
  commands run on every pull request and on `main`
  (`.github/workflows/ci.yml`, Linux and macOS, node 22.18.0 and 24) — CI adds
  nothing that cannot be reproduced locally.
