# notabene: architecture

Diff review for Claude Code. `!ntb` from the session shows the changes in the
external [hunk](https://hunk.dev) viewer, collects inline comments and prints
them as a batch to stdout — from there the text lands in the agent's context.

Why it is this way — [DECISIONS.md](DECISIONS.md). How to use it — [README.md](README.md).

---

## 1. Flow

```
!ntb
  → session resolve (env → pid chain)
  → review root = git repository root
  → changesets: Current + T1..Tn (this is also the turn switcher)
  → handoff file + viewer launch (launcher)
  → block until the viewer closes
  → read the comment mirror → batch to stdout + JSON copy
```

The viewer lives **outside** the `!`-command: the command has no controlling
terminal (§5). Three ways to show it — a Herdr pane, a kitty tab, manually in a
second terminal; the choice is made by environment autodetection (§5).

An empty review (no changes or no comments) — empty stdout, the agent stays silent.

## 2. Modules

```
ntb                     sh wrapper: the single entry point, resolves symlinks, execs node
install.sh              install and update: clone → tag → npm ci → symlinks (§7)
src/
├── cli.ts              argument parsing, exit codes, Ctrl-C
├── run.ts              the whole flow: session → root → changesets → launcher → collection
├── io.ts               output contract: emit() to stdout, log.* to stderr, EXIT, ReviewError
├── update.ts           `ntb update`: the installer's other half, git tags only (§7)
├── time.ts             ISO-8601 with local offset
├── model/
│   ├── diff.ts         Changeset / FileDiff / Hunk / HunkLine, DiffSource interface
│   └── review.ts       ReviewDocument / ReviewComment (§3.2), CommentStore interface
├── session/            SessionSource: env → pid chain → registry (§4.1)
│   ├── index.ts        source chain + transcript lookup
│   ├── registry.ts     ~/.claude/sessions/<pid>.json
│   ├── transcript.ts   ~/.claude/projects/<slug>/<session-id>.jsonl
│   ├── proc.ts         walking process ancestors (ps)
│   └── types.ts        SessionInfo / SessionContext / SessionSource
├── diff/               DiffSource: changesets() → Changeset[]
│   ├── current.ts      git diff HEAD + untracked; unified-patch parsing; gitToplevel()
│   ├── turns.ts        per-turn from file-history (§4.3), replay fallback, degradation
│   ├── jsonl.ts        transcript parser: turns, snapshots, deltas, replay material
│   ├── text-diff.ts    own LCS diff (no dependencies), hunks with 3 context lines
│   └── index.ts        source names, options, assembly
├── launcher/           Launcher: open() / waitForDone() / collect()
│   ├── detect.ts       environment detection via env (no process spawning)
│   ├── herdr.ts        flow A: Herdr pane
│   ├── kitty.ts        flow B: kitty tab
│   ├── manual.ts       flow C: viewer right here, or instructions
│   ├── index.ts        herdr → kitty → manual chain, timeouts
│   └── types.ts        Launcher / OpenOptions / WaitOptions / DoneReason
├── hunk/               CLI ↔ viewer bridge
│   ├── handoff.ts      handoff file and mirror: write, read, cleanup (§3.3)
│   ├── notes.ts        mirror → ReviewComment; types from prefixes; context lines
│   ├── patch.ts        model → unified patch for the VCS adapter
│   └── bin.ts          resolving the platform hunk binary, the extension directory, the ntb wrapper
├── hunk-ext/index.ts   hunk extension: VCS adapter, mirror, turn switching
├── store/index.ts      CommentStore: pending cycle and machine-readable copies
└── delivery/index.ts   Delivery: batch formatter (§3.1) + write to stdout
```

Abstractions and their implementations:

| Interface | Declared in | Implementations |
|---|---|---|
| `SessionSource` | `session/types.ts` | env, pid chain |
| `DiffSource` | `model/diff.ts` | `current`, `turns` |
| `Launcher` | `launcher/types.ts` | `herdr`, `kitty`, `manual` |
| `CommentStore` | `model/review.ts` | `fileCommentStore` (files in `.claude/reviews/`) |
| `Delivery` | `delivery/index.ts` | `stdout` |

## 3. Contracts

### 3.1. Batch in stdout

The only thing the happy path writes to stdout. `@path:start-end` references
and comment text, no diff retelling:

```
Review of the turn T3 diff ("fix the dagger balance, knockback…"), 2 comments.
Address each item; make the edits, then briefly summarize: what you changed,
what you skipped and why. If an item is unclear, ask a clarifying question about it.

1. @src/weapons.ts:42-48 [change]
   Knockback is hardcoded — move it into WEAPON_CONFIG.

2. @src/balance.md:10 [question] (deleted line, old:10)
   Why was the crit item removed? It had been agreed on.

Machine-readable copy: .claude/reviews/2026-09-13T20-15-31.json
```

- Paths are relative to the repository root (§5.5), same order as in the mirror.
- Comment type — `[question]` / `[change]` / `[blocker]`, set by a prefix in
  the body (`[q]`/`[c]`/`[b]`; the full words `[question]`/`[change]`/`[blocker]`
  are accepted too), because hunk has no types.
- A comment on the old side: referenced by the same number; the side and the
  exact anchor go in parentheses and into the JSON.
- Context lines (`--context`) — up to three per item, added greedily while the
  batch fits into `STDOUT_LIMIT` = 25,000 characters; trimmed context is
  mentioned only under `--verbose`. **Comments are never trimmed**; if the
  batch exceeds the limit even without context — a warning goes to stderr.
- Empty review → empty string → `emit()` writes nothing.
- **The header is an agent-facing contract.** It is the instruction the agent acts
  on, so rewording it changes behaviour, not just wording — snapshot fixtures and
  `test/delivery.test.ts` move in the same change. Command names deliberately do
  not appear in it, which is why CLI surface changes are not contract changes.

### 3.2. Machine-readable copy

`<repo>/.claude/reviews/<name>.json`, where the name is `createdAt` truncated
to seconds, without the offset and with `:` → `-` (on collision — suffix `-2`,
`-3`):

```json
{
  "version": 1,
  "createdAt": "2026-09-13T20:15:31+03:00",
  "source": { "mode": "turn", "turn": 3, "sessionId": "f5bf67f3-…", "promptSnippet": "fix the dagger balance…" },
  "comments": [
    {
      "id": "user:1789327445165-1", "file": "src/weapons.ts", "side": "new",
      "startLine": 42, "endLine": 48, "hunk": null,
      "type": "change", "body": "Knockback is hardcoded…", "context": ["  const KB = 4;"],
      "status": "open", "resolvedBy": null
    }
  ]
}
```

`type`, `status`, `resolvedBy` have lived in the schema from day one, even if
the UI doesn't fill them. `hunk` is always `null` — the extension doesn't
mirror the hunk index.

### 3.3. Handoff and the comment mirror

An internal CLI ↔ extension contract, both files in `<repo>/.claude/reviews/`:

- **`handoff.json`** is written by the CLI before launching the viewer: `root`,
  `notesPath`, `hunkBin`, `activeId` and all changesets (label, unified patch,
  full texts of both sides for `readFileSource`). The path travels to the
  viewer via the `NOTABENE_HANDOFF` env var.
- **`notes-<createdAt>.json`** (name truncated like the §3.2 copy) is written
  by the extension: one write per note event, via a temp file and `rename`. The
  name is unique per review so that a viewer left open doesn't clobber the next
  review's mirror; readers take the path from the handoff.
- **`notes-<createdAt>.outcome.json`** appears only when the user cancels the
  review (`x` in the viewer): `{"version": 1, "outcome": "cancelled"}`. Its
  absence is the normal case — quitting the viewer any other way delivers the
  comments (D28). The name is derived from the mirror's so that one cleanup
  pattern covers both.
- `pending.json` links `open` and `collect`: without it, the collection
  step knows neither the turn nor the prompt snippet.

The extension (`src/hunk-ext/index.ts`) is **self-contained**: the hunk loader
executes it, our modules are unavailable to it, so the schemas are duplicated
structurally. The synchrony is guarded by `test/hunk-ext.test.ts` (verified by
mutation: renaming any contract field that is read breaks the test;
`previousPath` isn't read by the extension, so the test doesn't cover it).

When the review session closes (batch delivered, no comments, or the review was
cancelled), `pending`, the handoff and the mirrors are removed; the
machine-readable copies remain — a cancelled review leaves none, since nothing
was reviewed. Exception: if the viewer failed to open, only `pending` is removed —
a handoff without it is read by nobody and is kept for inspection.

### 3.4. Exit codes

Declared in `src/io.ts`, no other values are used:

| Code | Meaning |
|---|---|
| 0 | success, including "review is empty, stdout is empty" |
| 1 | runtime error |
| 2 | usage error (unknown flag, incompatible modes) |
| 3 | stub for an unimplemented ticket (unreachable in the current code) |
| 130 | Ctrl-C |

The single exception outside `EXIT` is the sh wrapper `ntb`: without
`node` in `PATH` it exits with 127 (the shell "command not found" convention),
the TS code is never reached.

## 4. Claude Code data

Everything in this section is **Claude Code's internal format**, not officially
documented. Hence the degradation requirement: an unfamiliar schema doesn't
break the review but narrows it to Current with a warning.

### 4.1. Session resolution

1. **env**: `CLAUDE_CODE_SESSION_ID` reaches both the Bash tool and the
   `!`-command. `CLAUDE_PID` — the pid of the `claude` process.
2. **pid chain**: walking up the process ancestors to a
   `~/.claude/sessions/<pid>.json` record (`{pid, sessionId, cwd, kind, status, …}`).
   Correctly distinguishes parallel sessions in one repository — each has its
   own pid.

`cwd` is taken from the registry if it refers to the same session: `review` may
have been started from a subdirectory. The ancestor walk is depth-limited and
cycle-protected.

### 4.2. Transcript

`~/.claude/projects/<slug>/<session-id>.jsonl`, where the slug is the project
path with everything non-alphanumeric replaced by a dash. If the slug doesn't
match — a directory scan. One session = one id = one transcript = one
file-history directory.

Turn boundaries are user records (`type: "user"`, not `isMeta`, not
`isSidechain`, content not `tool_result`); the same records provide the prompt
snippets for the labels. Service wrappers (`<command-name>`, `<bash-input>`, …)
are collapsed into a readable form.

### 4.3. file-history (per-turn diff)

- `file-history-snapshot` is written when a user message is sent;
  `messageId` == this record's `uuid` — that is the turn boundary.
- `snapshot.trackedFileBackups` is a **cumulative** set of tracked files
  (`<hash>@vN`), not the turn's changes. "What turn N touched" = comparing
  adjacent snapshots by `backupFileName`. Counting by set size is a mistake.
- The versions themselves are full file copies in `~/.claude/file-history/<session-id>/`.
- The "before" state of a file first tracked mid-turn is not in the snapshot
  but in the `@v1` backup of its `file-history-delta` (the backup is written
  before the first edit; `null` — the file didn't exist).
- For the last snapshot, "after" is taken from disk, and only inside the review root.
- The hash in `backupFileName` is not path-stable across versions.
- Fallback when a backup is lost: replaying `toolUseResult.structuredPatch` /
  `originalFile` / `content` from Edit/Write records.
- Turn numbering can diverge from the built-in `/diff` (service turns, snapshot
  gaps) — hence the prompt snippet always in the label.

The turn switcher = Current + the turns whose comparison yielded a non-empty
result, newest first.

## 5. Launch model

### 5.1. Why the viewer is external

Under `!` the process has **no controlling terminal**: `open("/dev/tty")` fails
with ENXIO, stdin/stdout/stderr are pipes. A TUI inside a `!`-command is
impossible. But a `!`-command is synchronous, so the viewer can live elsewhere
while `!ntb` shows it a changeset, blocks, and collects the comments.

### 5.2. Flow A — Herdr pane (detection: `HERDR_ENV`)

`pane list` (looking for our pane by the name `notabene`) → if absent,
`pane split --current --direction right --no-focus` + `pane rename` → `pane run`
with the viewer command → `pane wait-output --match <sentinel>` → mirror read.
The sentinel is printed by `printf` from two parts, otherwise `wait-output`
finds it in the echo of the command itself. The pane isn't closed after the
review — it's reused by name.

### 5.3. Flow B — kitty tab (detection: `KITTY_LISTEN_ON`, otherwise `KITTY_PID`)

`kitty @ launch --type=tab` → window id → polling `kitty @ ls --match id:<wid>`
(exit 0 — window alive, 1 — closed). Separately from remote-control
availability, detection recognizes the "the terminal is kitty" signal
(`KITTY_WINDOW_ID`, `TERM=xterm-kitty` or `KITTY_PID`) — when manual is chosen,
it triggers the first-run hint about the two config lines. Pitfalls baked into
the adapter:

- `kitty @ launch` runs the command in **kitty's own** environment (on GUI
  launch `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, rc files were never read), and
  `--copy-env` doesn't help. So the viewer is invoked as the platform binary by
  absolute path, and `PATH`/`HOME`/`NOTABENE_HANDOFF` are passed via `--env`.
- Requires the one-time `~/.config/kitty/kitty.conf` edit
  (`allow_remote_control socket-only`, `listen_on unix:/tmp/kitty`) and a full
  kitty restart: `listen_on` isn't picked up by a config reload.
- `--wait-for-child-to-exit` isn't used — it stopped returning control
  (DECISIONS.md D5), so waiting is done by polling.
- A viewer that dies within the first 3 seconds without creating the mirror
  counts as failed to launch — that's an error, not a "review with no comments".
- Up to three consecutive `kitten @` client non-responses count as interference
  (the socket may have been recreated); beyond that — an error.

### 5.4. Flow C — manual (always available)

In a live terminal, `ntb open` launches the viewer right there and waits
for it; under `!` there is no terminal, so instructions are printed. Collection
is a separate command, `ntb collect`, which doesn't build a launcher at
all. `open` picks up an already prepared review and doesn't require a Claude
Code session; if there is no prepared review but a session was resolved, it
prepares one from scratch and opens the viewer right there.

The printed instruction spells the command with `ntbCommand()` (`hunk/bin.ts`):
bare `ntb` only when that name on `PATH` resolves to this very wrapper, and the
absolute path otherwise. The hint is meant to be typed in a second terminal,
where a development checkout is never on `PATH` and a stranger's `ntb` might be.

### 5.5. Root, locking, timeouts

- **Review root** — the git repository root (`git rev-parse --show-toplevel`
  from the session cwd); outside a repository — the cwd itself. Changeset paths
  and batch references are computed from it; `.claude/reviews/` lives in it.
- **The `!`-command ceiling is 120 s** (the `BASH_DEFAULT_TIMEOUT_MS` default).
  Past that, Claude Code detaches the command ("moved to the background") but
  doesn't kill it: the viewer lives on, the batch arrives as a
  background-task-completed notification, from whose file the agent reads the
  text.
- **Viewer wait timeout — 30 minutes** (`--timeout`). On expiry we exit with
  empty stdout and leave the viewer open: `collect` will pick up the comments.
- **Ctrl-C** interrupts the wait in both blocking flows (exit 130); the viewer
  is left alone.
- **One review per repository at a time**: the session files are shared, so a
  run on top of an unfinished review session is a refusal with a hint, not a
  silent overwrite.

## 6. Invariants

Must not be broken; most have a guard.

| Invariant | Held by |
|---|---|
| Only `emit()` from `src/io.ts` writes to stdout; all diagnostics go to stderr | `test/stdout-contract.test.ts` (catches `process.stdout`, all `console.*` except warn/error, `writeSync(1`) |
| Zero runtime dependencies except the pinned `hunkdiff@0.22.0` | `package.json` |
| No build step: Node runs TS directly → syntax must be erasable, imports carry the `.ts` extension | `erasableSyntaxOnly` + `allowImportingTsExtensions` in `tsconfig.json` |
| The installed source must not sit under a `node_modules` directory — Node refuses to strip types there | `install.sh` owns the layout; `test/install.test.ts` runs the installed CLI |
| `src/hunk-ext/index.ts` is self-contained and duplicates the schemas structurally | `test/hunk-ext.test.ts` |
| Exit codes only from `EXIT` (`src/io.ts`) | §3.4 |
| Tests that run `./ntb` must set `cwd` | shared temp directory by default in `test/cli.test.ts` |
| Empty review → empty stdout | e2e in `test/cli.test.ts` |
| Unfamiliar file-history schema → degradation to Current with a warning | `test/diff-turns.test.ts` |

## 7. Distribution

One channel: `install.sh` fetched with `curl`. The layout is constrained by §6 —
the installed source must sit outside any `node_modules` directory, because Node
refuses to strip types there.

```
install.sh  clone → checkout newest tag → npm ci --omit=dev → symlink → marker
src/update.ts   ntb update: the same steps on an already marked directory
```

| Piece | Value |
|---|---|
| install root | `${XDG_DATA_HOME:-~/.local/share}/notabene` (`--root`) |
| symlinks | `~/.local/bin/{ntb,notabene}` → `<root>/ntb` (`--bindir`) |
| release | a `vX.Y.Z` git tag; `--version` reads `package.json` (§7.1) |
| marker | `<root>/.managed-install` |

`install.sh --help` lists the four flags — `--ref`, `--root`, `--bindir`,
`--repo`. Each also reads an environment variable of the same name
(`NOTABENE_REF` and so on): a piped `curl | sh` can take flags only through
`sh -s --`, and the test suite sets the environment rather than the arguments.

Two properties are load-bearing:

- **The marker is a guard, not bookkeeping.** A developer's checkout is
  indistinguishable from an install except for it, and both the installer
  (before `checkout`) and `ntb update` refuse to touch a directory without it.
  Otherwise an update would discard uncommitted work.
- **Updating is git and nothing else** — tags are the release list, so there is
  no HTTP client, no registry API, and no rate limit; the zero-dependency
  invariant holds on this path too. `ntb update --check` only reports.

Re-running the installer is the same code path as `update`, so "install" and
"update" cannot drift apart. `npm` is stubbed in `test/install.test.ts`: the real
`npm ci` pulls a ~100 MB viewer binary.

A Claude Code plugin is the natural second channel when one is wanted: a plugin's
`bin/` lands on the Bash tool's `PATH`, and this repository plus a manifest is all
it takes.

### 7.1. Versioning and releases

SemVer, below 1.0 for now. The public surface is everything that changes how the
tool is used: commands and flags (§1), exit codes (§3.4), the stdout batch (§3.1),
the machine-readable copy (§3.2), install paths and `NOTABENE_*` variables, the
`engines.node` floor, and the pinned viewer — a new pin costs every user a ~100 MB
download, so it is never a silent patch. The `version` fields inside the on-disk
artefacts (§3.2, §3.3) are a separate axis and do not move with the product.

| Rule | |
|---|---|
| numbering | `feat` → minor, `fix`/`perf` → patch, breaking → minor while < 1.0 |
| tag | `vX.Y.Z`, the only shape that counts as a release |
| pre-releases | none — version sort ranks `v1.0.0-rc.1` *above* `v1.0.0` |
| tags | immutable; a bad release is fixed by the next patch, never by retagging |
| source of truth | `package.json`; the tag is cut from it, so the two cannot drift |

The mechanism is release-please (`.github/workflows/release-please.yml`): it keeps
a pull request open that bumps `package.json`, `package-lock.json` and
`CHANGELOG.md` from the conventional commits since the last release, and on merge
creates the tag and the GitHub release. `CHANGELOG.md` is generated — DECISIONS.md
stays the place for *why*, the changelog only records *what changed*.

Two consequences worth naming. Retagging would not work even if the policy allowed
it: `git fetch --tags --prune` does not delete a tag that vanished from the remote
(that needs `--prune-tags`, which neither the installer nor `update` passes), so a
withdrawn release would live on in every existing install. And "newest" is only
well defined because of the two rules above — the installer and `ntb update` both
take the first of `git tag --list 'v[0-9]*' --sort=-v:refname`.

## 8. Limitations

- A review longer than ~2 minutes becomes asynchronous (§5.5).
- Comments left after switching turns inside the viewer end up in the batch
  under the original turn's header; their `file:line` anchor is their own,
  correct one.
- No "file viewed" marks — hunk doesn't have them.
- The turn switcher lives only within a session: new session = new id = empty
  file-history, numbering starts over.
- Batch references are relative to the repository root; with a session in a
  subdirectory they have to be read relative to the root.
- macOS: the paths to kitty and to the platform hunk binary assume the macOS
  layout.
- Known review findings left undone are listed in
  [DECISIONS.md](DECISIONS.md) (D22).
