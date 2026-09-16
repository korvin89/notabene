# notabene: architecture

Diff review for Claude Code. `/ntb:review` from the session shows the changes in the
external [hunk](https://hunk.dev) viewer, collects inline comments and prints
them as a batch to stdout — from there the text lands in the agent's context.

Why it is this way — [DECISIONS.md](DECISIONS.md). How to use it — [README.md](README.md).

---

## 1. Flow

```
/ntb:review  (the plugin skill; the agent runs `ntb` blocking, §5.6)
  → session resolve (env → pid chain)
  → review root = git repository root
  → changesets: every scope that applies (§4.2) — this is also the scope picker
  → handoff file + viewer launch (launcher)
  → block until the viewer closes
  → read the comment mirror → batch to stdout + JSON copy
```

`!ntb` typed by the user runs the same code and produces the same batch. The two
entry points diverge only past the detach ceiling (§5.6).

The viewer lives **outside** the `!`-command: the command has no controlling
terminal (§5). Three ways to show it — a Herdr pane, a kitty tab, manually in a
second terminal; the choice is made by environment autodetection (§5).

An empty review (no changes or no comments) — empty stdout, the agent stays silent.

## 2. Modules

```
ntb                     sh wrapper: the single entry point, resolves symlinks, execs node
install.sh              install and update: clone → tag → npm ci → symlinks (§7)
.claude-plugin/         the Claude Code plugin (§7.2) — how `/ntb:review` reaches the user
├── marketplace.json    marketplace manifest: `/plugin marketplace add`
├── plugin.json         plugin manifest; `version` is bumped by release-please
└── skills/review/     the agent-facing instruction: run blocking, never in background
src/
├── cli.ts              argument parsing, exit codes, Ctrl-C
├── run.ts              the whole flow: session → root → changesets → launcher → collection
├── io.ts               output contract: emit() to stdout, log.* to stderr, EXIT, ReviewError
├── update.ts           `ntb update`: the installer's other half, git tags only (§7)
├── plugin.ts           what Claude Code records about our plugin (§7.2)
├── time.ts             ISO-8601 with local offset
├── model/
│   ├── diff.ts         Changeset / FileDiff / Hunk / HunkLine, ScopeId
│   └── review.ts       ReviewDocument / ReviewComment (§3.2), CommentStore, describeSource()
├── session/            SessionSource: env → pid chain → registry (§4.1)
│   ├── index.ts        source chain
│   ├── registry.ts     ~/.claude/sessions/<pid>.json
│   ├── slug.ts         Claude Code's project slug — the state directory borrows it
│   ├── proc.ts         walking process ancestors (ps)
│   └── types.ts        SessionInfo / SessionContext / SessionSource
├── diff/               the scopes a run offers (§4.2)
│   ├── scopes.ts       planning and building them; git plumbing; gitToplevel()
│   └── parse.ts        unified-patch parser (pure)
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
├── hunk-ext/index.ts   hunk extension: VCS adapter, mirror, scope switching
├── store/
│   ├── index.ts        CommentStore: state directory, pending cycle, machine-readable copies
│   └── migrate.ts      one-time move of a pre-D30 `<repo>/.claude/reviews/`
└── delivery/index.ts   Delivery: batch formatter (§3.1) + write to stdout
```

Abstractions and their implementations:

| Interface | Declared in | Implementations |
|---|---|---|
| `SessionSource` | `session/types.ts` | env, pid chain |
| `Launcher` | `launcher/types.ts` | `herdr`, `kitty`, `manual` |
| `CommentStore` | `model/review.ts` | `fileCommentStore` (files in the state directory, §3.2) |
| `Delivery` | `delivery/index.ts` | `stdout` |

## 3. Contracts

### 3.1. Batch in stdout

The only thing the happy path writes to stdout. `@path:start-end` references
and comment text, no diff retelling:

```
Review of the diff since main, 2 comments.
Address each item; make the edits, then briefly summarize: what you changed,
what you skipped and why. If an item is unclear, ask a clarifying question about it.

1. @src/weapons.ts:42-48 [change]
   Knockback is hardcoded — move it into WEAPON_CONFIG.

2. @src/balance.md:10 [question] (deleted line, old:10)
   Why was the crit item removed? It had been agreed on.

Machine-readable copy: /Users/x/.claude/notabene/-Users-x-games-roguelike/2026-09-13T20-15-31.json
```

- The header names the reviewed scope (§4.2) — `describeSource()` in
  `model/review.ts` is the one place that spells it, shared with the "there is
  already an unfinished review of …" refusal so the two cannot drift.
- Paths are relative to the repository root (§5.5), same order as in the mirror.
  The copy at the tail is the exception: it lives outside the tree (§3.2), so
  its path is absolute.
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

### 3.2. The state directory and the machine-readable copy

Everything `ntb` writes lives in **one directory outside the reviewed tree**
(D30):

```
<claudeDir>/notabene/<slug>/
```

`claudeDir` is Claude Code's state directory (`CLAUDE_CONFIG_DIR`, by default
`~/.claude`), `slug` is its own project slug — the review root with every
non-alphanumeric character replaced by a hyphen, the same `projectSlug()` that
finds transcripts in `~/.claude/projects/` (§4.1). The key is the **review
root**, not the session cwd: two sessions in one repository, one of them started
in a subdirectory, must find each other's review (D14).

Nothing is written into the repository — no `.gitignore` line to ask for, no
untracked files, nothing under a file watcher. A pre-D30 `<repo>/.claude/reviews/`
is moved here on the first run and removed (`store/migrate.ts`).

The directory holds the copies described below and the session files of §3.3.

**Machine-readable copy** — `<stateDir>/<name>.json`, where the name is
`createdAt` truncated to seconds, without the offset and with `:` → `-` (on
collision — suffix `-2`, `-3`):

```json
{
  "version": 1,
  "createdAt": "2026-09-13T20:15:31+03:00",
  "source": { "scope": "since", "against": "main", "sessionId": "f5bf67f3-…" },
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
mirror the hunk index. `source.scope` is one of the §4.2 ids and `against` is the
revision as the user named it; before D31 the same slot held `mode`/`turn`/
`promptSnippet`, which is why `describeSource()` still has a fallback arm — the
pending document of a review started under the old version is read back by the
new one.

The copies are not history for its own sake and nothing reads them back: they
are the fallback for a batch that never reached the agent (stdout swallowed, the
task file unread), which is why they survive the cleanup below. Hence no
rotation either — one is 0.5–1.2 KB.

### 3.3. Handoff and the comment mirror

An internal CLI ↔ extension contract, both files in the state directory (§3.2):

- **`handoff.json`** is written by the CLI before launching the viewer: `root`,
  `notesPath`, `hunkBin`, `activeId` and all changesets (label, unified patch,
  full texts of both sides for `readFileSource`). The path travels to the
  viewer via the `NOTABENE_HANDOFF` env var. It is the heaviest file we write:
  the scopes overlap, so a file changed on a branch has its text in the handoff
  once per scope that contains it.
- **`notes-<createdAt>.json`** (name truncated like the §3.2 copy) is written
  by the extension: one write per note event, via a temp file and `rename`. The
  name is unique per review so that a viewer left open doesn't clobber the next
  review's mirror; readers take the path from the handoff.
- **`notes-<createdAt>.outcome.json`** appears only when the user cancels the
  review (`x` in the viewer): `{"version": 1, "outcome": "cancelled"}`. Its
  absence is the normal case — quitting the viewer any other way delivers the
  comments (D28). The name is derived from the mirror's so that one cleanup
  pattern covers both.
- `pending.json` links `open` and `collect`: without it, the collection step
  would not know which scope was reviewed, and the batch header would have
  nothing to name.

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

## 4. Inputs

### 4.1. Session resolution

`~/.claude/sessions/<pid>.json` is **Claude Code's internal format**, not
officially documented — an unfamiliar schema must narrow what we can do, never
break the run.

1. **env**: `CLAUDE_CODE_SESSION_ID` reaches both the Bash tool and the
   `!`-command. `CLAUDE_PID` — the pid of the `claude` process.
2. **pid chain**: walking up the process ancestors to a
   `~/.claude/sessions/<pid>.json` record (`{pid, sessionId, cwd, kind, status, …}`).
   Correctly distinguishes parallel sessions in one repository — each has its
   own pid.

`cwd` is taken from the registry if it refers to the same session: `ntb` may
have been started from a subdirectory. The ancestor walk is depth-limited and
cycle-protected.

The session gives two things and no more: the id that goes into the review
document, and the cwd the review root is derived from. Nothing in the diff
depends on Claude Code any longer (D31) — the session's transcript and
file-history are not read at all.

### 4.2. Review scopes

A scope is one git comparison. A run builds every scope that applies and hands
them all to the viewer, which switches between them with `<`/`>`/`T`; the
command line only picks which one opens first. The reason the list exists rather
than a single scope per invocation: with `/ntb:review` the *agent* starts the review
(§5.6), so the human never passes the arguments.

| id | Comparison | Untracked | Offered when |
|---|---|---|---|
| `worktree` | `git diff HEAD` | yes | always |
| `staged` | `git diff --cached HEAD` | no | `git diff --cached` is non-empty, or `--staged` was asked for |
| `since` | `git diff $(git merge-base <ref> HEAD)` | yes | on a branch ahead of its base, or a revision was given |
| `range` | `git diff <a> <b>` | no | two revisions were given |

Details that are decisions, not incidentals:

- **`since` is the merge base, not the ref.** A plain `git diff main` also
  reverses whatever `main` gained since the branch point; the merge base gives
  "what this branch added", which is what the question means.
- Its right-hand side is the **working tree**, not HEAD: in an agent session the
  interesting work is usually not committed yet.
- The base branch is `origin/HEAD` if git records it, else `main`, else
  `master`; a local branch of that name wins over the remote ref, because that
  is the name the human thinks in.
- A scope with no files is dropped. If it was asked for explicitly it is not
  silently swapped for another one — the run says "Nothing staged" and exits 0.
- Without a request the run opens the first non-empty of worktree → since →
  staged, so committed branch work with a clean tree opens on `since` instead
  of being answered "No changes".
- `<ref>` resolving to HEAD itself makes `since` identical to the working tree,
  so it is dropped as a duplicate.
- Both sides' full texts are read for `readFileSource`, through one per-run
  cache: the scopes overlap heavily and without it the same blob is fetched
  once per scope.

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
  and batch references are computed from it, and it is the key of the state
  directory (§3.2) — which itself lives elsewhere.
- **The detach ceiling belongs to the caller, not to us**: 120 s for a
  `!`-command (the `BASH_DEFAULT_TIMEOUT_MS` default, `BANG_DETACH_MS`), and the
  `timeout` the agent passes for `/ntb:review` — 600 s, the Bash tool's maximum. Past it
  Claude Code detaches the command ("moved to the background") but doesn't kill
  it: the viewer lives on and the batch goes to the task file. Who reads that
  file, and when, is §5.6. Because the number is the caller's, the stderr warning
  names the effect and never a duration.
- **Viewer wait timeout — 4 hours** (`--timeout`). On expiry we exit with
  empty stdout and leave the viewer open: `collect` will pick up the comments.
  It was 30 minutes until a live run expired mid-review and cost the delivery
  path (D29); expiry is a fallback, not a normal ending.
- **Ctrl-C** interrupts the wait in both blocking flows (exit 130); the viewer
  is left alone.
- **One review per repository at a time**: the session files are shared, so a
  run on top of an unfinished review session is a refusal with a hint, not a
  silent overwrite.

### 5.6. Who owns the process

The two entry points run identical code and differ in one thing: whose process it
is. That decides what happens after the detach.

| | `/ntb:review` (plugin skill) | `!ntb` (typed by the user) |
|---|---|---|
| owner | a Bash-tool call inside an agent turn | the user's local command |
| under the ceiling | batch returns inline in the tool result | batch is part of the user's next message |
| past the ceiling | the completion notification **re-invokes the agent**, which reads the task file and acts | nothing to re-invoke: the batch waits for the user to write to the agent |

That asymmetry is the whole reason the plugin exists (D29). It also fixes the
shape of the skill's instruction: the agent must call `ntb` **blocking**, with the
harness's maximum timeout, and must never use `run_in_background` — a detached
interactive TUI launcher is unreliable, and the polling loop it invites leaves the
session idle exactly when the review finishes.

`ntb` itself knows none of this. It has no flag for the caller, no branch on it,
and the batch header (§3.1) is the same either way.

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
| Nothing of ours is written into the reviewed repository | `tree()` assertions in `test/cli.test.ts` |
| An explicitly requested scope is never silently swapped for another one | `test/diff-scopes.test.ts`, `test/cli.test.ts` |

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

The Claude Code plugin is the second channel — §7.2. It ships the entry point, not
the code, so the two channels are not alternatives: both are needed for `/ntb:review`.

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

### 7.2. The plugin channel

`.claude-plugin/` makes this repository its own single-plugin marketplace:

```
/plugin marketplace add korvin89/notabene    → marketplace.json
/plugin install ntb@notabene                 → plugin.json → skills/review/SKILL.md
/ntb:review                                  → the skill
```

Three names, two syntaxes, and both stutter if you let them. Installation is
`plugin@marketplace`, so the marketplace carries the brand (`notabene`) and the
plugin the command (`ntb`) — naming both alike is what produces the `name@name`
seen in comparable plugins. Invocation is `plugin:skill`, which is the same trap
one level down: the skill was called `ntb` too, and the command came out as
`/ntb:ntb`. It is named after what it does instead, which also leaves the
namespace usable — `/ntb:collect` has a CLI command waiting for it if the
two-step flow ever deserves its own skill.

The plugin ships **no code**: `source` is the repository root, but the only thing
Claude Code reads from it is the skill. `ntb` itself still comes from `install.sh`,
so a user needs both. That is a real wart, and the two candidate fixes are for
`install.sh` to print the two plugin lines, or for the skill to bootstrap the CLI
on first use; neither is done.

Three version strings live outside `package.json` and all three are wired into
release-please `extra-files`: the two manifest fields (`$.version`,
`$.plugins[0].version`, both `json`) and the floor inside the skill (`generic`).
Without that they drift from `package.json` at the first release, which §7.1
promises they cannot.

**The two halves update separately, so `ntb update` reports the other one** (D32).
It reads Claude Code's own record, `<claudeDir>/plugins/installed_plugins.json`
(`src/plugin.ts`), and prints the install lines when the plugin is absent, or the
update lines — plus the restart, which is what a plugin update needs to apply —
when the plugin is behind *and* this release changed the skill. Otherwise nothing.

That second condition is the whole design. Since release-please bumps the
manifests every release, the installed plugin is numerically behind after every
one of them, while `skills/` changes rarely; a hint keyed on the version gap
would fire every time and be learned as noise. Hence the gate is a diff of
`.claude-plugin/skills` between `v<plugin version>` and `v<cli version>` — the
manifests' own churn is outside that path by construction.

`ntb update` cannot go further than reporting: the plugin is Claude Code's state,
not ours, and applying a plugin update needs Claude Code restarted (D32).

**The skill carries a version floor**, and it is there for the drift `ntb update`
cannot see. A CLI ahead of the skill is harmless — the agent merely fails to know
about a new flag. A *skill* ahead of the CLI is not: it tells the agent to pass
arguments this `ntb` has never heard of, and the agent finds out as a usage error
in the middle of a review. So the skill names the release it ships with and tells
the agent to compare `ntb --version` against it — but only after a usage error,
never up front, because a version check on every launch would cost a tool call
per review to catch something rare.

The number is maintained by release-please rather than by hand: a floor edited
manually rots within two releases and then misdiagnoses every failure it sees.
The `generic` updater rewrites the semver on any line carrying an
`x-release-please-version` annotation — verified against this repository's own
`SKILL.md` with release-please 17.11.2, one line changed, the rest untouched.
`test/skill.test.ts` guards the three parts that have to stay true together: the
annotated line, the `extra-files` entry pointing at it, and the floor matching
`package.json` right now.

## 8. Limitations

- A long review becomes asynchronous (§5.5); after `!ntb` the batch then waits
  for the user to write to the agent, because nothing wakes it (§5.6).
- `/ntb:review` needs both the CLI and the plugin installed (§7.2).
- Comments left after switching scope inside the viewer end up in the batch
  under the scope the review opened on; their `file:line` anchor is their own,
  correct one.
- No "file viewed" marks — hunk doesn't have them.
- The handoff carries the full text of both sides of every file in every scope,
  and the scopes overlap: a long-lived branch makes it several megabytes.
- Batch references are relative to the repository root; with a session in a
  subdirectory they have to be read relative to the root.
- macOS: the paths to kitty and to the platform hunk binary assume the macOS
  layout.
- Known review findings left undone are listed in
  [DECISIONS.md](DECISIONS.md) (D22).
