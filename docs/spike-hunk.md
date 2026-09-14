> References of the form "DESIGN.md §N" below point to the original design document:
> on 2026-09-14 it was folded into [ARCHITECTURE.md](../ARCHITECTURE.md) and
> [DECISIONS.md](../DECISIONS.md). The experiment text is left as is.

# T1b — hunk spike

> Translated from the Russian original on 2026-09-14; the protocol content is preserved as recorded (DECISIONS.md D23).

Date: 2026-09-13. Version: **hunk 0.22.0** (`npm i -g hunkdiff`), MIT, TypeScript,
[modem-dev/hunk](https://github.com/modem-dev/hunk) — 9248 ★, last push on the day of the spike.

## How it was verified

Everything except the visual questions was verified programmatically. The live TUI was brought up
**not in the user's terminal**, but in an isolated pty (`script -q /dev/null hunk diff ...`) in the
background, killed on completion — this is automation, not interactive work. What was left for the
user's eyes is collected in the section "Remaining to check live".

Sandbox: `/tmp/hunk-spike/repo` (a git fixture: 1 modified .ts, 1 modified .md,
1 untracked), `/tmp/hunk-spike/turnrepo` (NOT a git directory, only the `.claude-diff-turns` marker),
the spike extension `/tmp/hunk-spike/ext/index.ts`.

## Installation — yes, but not the way we thought

`npm view hunk` is **somebody else's package** (`shannonmoeller/hunk`, "multipart files"). The right
one is `hunkdiff`.

```bash
npm i -g hunkdiff        # 28 packages, 19 s
hunk --version           # 0.22.0
```

Two facts that change the runtime assessment from DESIGN.md §2.3:

1. During installation npm complains `EBADENGINE`: the transitive `@opentui/core@0.5.11` requires
   `node >=26.4.0` or `bun >=1.3.0`, while the machine has Node 22.23.1. **This does not affect
   operation** (see item 2), but the user will see the warning during installation.
2. `bin/hunk.cjs` is a Node shim that simply spawns
   `node_modules/hunkdiff-darwin-arm64/bin/hunk` — a **99 MB standalone Mach-O arm64**.
   That is, Node takes no part at runtime, and the concern "Node startup 100–400 ms" from DESIGN.md §2.3
   does not apply to the viewer itself: Node is spent only on the shim (~25 ms, avoided by calling the
   binary directly). Alternatives with no Node at all: `curl -fsSL https://hunk.dev/install.sh | sh`,
   `brew install hunk`, `mise use -g hunk`.

## The ticket's five questions

### 1. Arbitrary changeset (old/new pairs NOT from git) — **YES**, verified with working code

The Extension API (`hunkdiff/extension`, **apiVersion 25**) provides `registerVcsAdapter()`. The adapter
returns `ExtensionVcsPatchResult { repoRoot, sourceLabel, title, patchText, readFileSource }` —
the patch can be synthesized out of anything.

I wrote a spike extension with a fake VCS `claude-diff-turns`: `detect(cwd)` hooks onto the marker
file, `operations["working-tree-diff"].load()` returns a unified diff assembled from **strings in the
extension's memory**, plus a `readFileSource` for the exact old/new documents.

```bash
cd /tmp/hunk-spike/turnrepo          # NOT a git repository
hunk diff --extension /tmp/hunk-spike/ext
hunk session list --json
```

The result — hunk rendered our synthetic changeset in a directory without any VCS:

```json
{ "inputKind": "vcs", "title": "Ход T1 («добавь knockback»)",
  "sourceLabel": "claude-diff: turn 1", "fileCount": 1,
  "files": [{ "path": "weapons.ts", "additions": 4, "deletions": 4, "hunkCount": 1 }] }
```

(The Russian `title` is recorded fixture data: "Turn T1 ('add knockback')".)

The extension's log: `loaded apiVersion=25` → `load range=undefined -> T1` → `changeset_loaded ...`.

This is exactly what DESIGN.md §2.3 feared ("risk #1: the depth of the extension API is unverified").
The risk is retired.

**Bonus — the turn switcher works too.** `input.range` from `hunk diff <ref>` makes it all the way to
the adapter, and a live session can be switched from outside:

```bash
hunk session reload <session-id> --source /tmp/hunk-spike/turnrepo --json -- diff T2
# -> { "title": "Ход T2 («вынеси конфиг»)", "sourceLabel": "claude-diff: turn 2", ... }
```

(The Russian `title` is recorded fixture data: "Turn T2 ('extract the config')".)

A caveat: the `registerCommand` handler has `ctx.review.snapshot()`, but **not** `requestReload()`
(it exists only in event contexts and reloads the same input). So a "next turn" key
inside the TUI = our command that shells out to `hunk session reload`. Works, but it is not pretty.

### 2. Comments: ranges / old side / editing — **partially YES**

| | Verdict | How verified |
|---|---|---|
| old side | **YES** | `hunk session comment add --repo . --file balance.md --old-line 2 --summary '…'` → `{"side":"old","line":2}`; in `comment list` — `"oldRange": [2,2]` |
| ranges in the model | **YES** | `ExtensionReviewNote.oldRange/newRange` — "Inclusive one-based … range, including singleton line anchors"; ranges are always present in the CLI JSON output |
| ranges in the UI | **likely yes, needs eyeballing** | the command table has `hunk.review.startVisualSelection` + `hunk.review.startNote`; the visual selection itself was not checked |
| ranges via the CLI | **NO** | `comment add` accepts exactly one anchor (`--old-line`/`--new-line`/`--hunk`); there is no range flag. `highlight add --start/--end` are **character** offsets within a single line, not lines |
| editing/deleting before sending | **YES** | commands `hunk.review.editActiveNote`, `deleteActiveNote`, `replyToActiveNote`; from the CLI — `comment rm`, `comment clear` |
| batch from stdin | **YES** | `printf '{"comments":[…]}' \| hunk session comment apply --repo . --stdin --json` — both items applied, whole-batch validation before mutation |

The batch schema from DESIGN.md §2.1 was confirmed word for word.

### 3. Reading comments from outside after exit — **NO**. Worked around with an extension

This is the main unpleasant finding, and it contradicts the optimism of DESIGN.md §2.1.

`hunk session *` works **only with a live session** via a local daemon (TCP on
`127.0.0.1`, registry in `~/.hunk/hunk-mcp/daemon-127-0-0-1-<port>.json`, Ed25519 keys in
`security-v1/`). The bundled skill says outright: "If no session exists, ask the user to launch
Hunk in their terminal first".

Verified: 5 comments in a live session → `kill` →

```
hunk session list --json        -> {"sessions": []}
hunk session comment list …     -> hunk: protocol-validation-failed
grep -rl "WEAPON_CONFIG" ~/.hunk ~/.config/hunk <repo>   -> nothing
```

**Comments live only in the process's memory. hunk does not write them to disk.**

There is a workaround, and it is verified: an extension subscribes to the events and writes them to
disk itself.

- `note_changed` (`kind: created|updated|removed`, payload `ExtensionReviewSnapshotNote` with
  `anchor.oldRange/newRange`, `source: "ai"|"agent"|"user"`, `resolution: active|stale|orphaned`) —
  a live mirror;
- `shutdown` — the final flush. The async handler **is awaited**, but with a budget of
  `EXTENSION_SHUTDOWN_TIMEOUT_MS = 250` (found in the bundle). Writing a small JSON fits,
  but relying on shutdown alone is not an option — hence the mirror on `note_changed`.

Verified in the spike: 2 comments → SIGTERM → `notes-shutdown.json` with both, and the log
`shutdown wrote 2 notes`.

**Clarification on the events (2026-09-13, after a live run of flow B).** `note_changed` alone is
not enough: in its payload the file path is represented only by an opaque
`fileKey: "file:<digest>"`, while `changeset_loaded` gives `id`+`path` but not `fileKey` — these two
events do not join up directly. The bundle shows how the key is built:
`reviewFileKey = file:${digest([sourceLabel, path, previousPath, duplicateIndex])}` — so computing it
is theoretically possible, but that is an internal, and the contract explicitly calls `fileKey`
opaque. The right path is different:

- `note_created` / `note_edited` return an `ExtensionReviewNote` via `projectExtensionReviewNote`,
  and it has **`filePath`**, `fileId`, `side`, `line`, `oldRange`, `newRange`, `body`, `draft`;
- `note_changed` remains the authoritative set of the ReviewStore, including **deletions**;
- they join on `id`, and it is shared: a user note is created with
  `noteId: user:${Date.now()}-${seq}` (verified on a live run — `user:1789327445165-1`).

Bottom line: we take the path from `note_created`/`note_edited` (filtering `draft: true`), and the set
membership from `note_changed`. The working implementation of this scheme is `src/hunk-ext/index.ts`
(it grew out of the `docs/probe-kitty-ext/` probe, deleted after the MVP was closed).

The second path — `registerCommand` + `ctx.review.snapshot()` (a full authoritative snapshot
`ExtensionReviewSnapshot { generation, stateRevision, files[], notes[] }`); the official example
`examples/extensions/review-snapshot-export` is built exactly this way. But `snapshot()` exists **only**
in a command context; there is none in an event context — so "export on F9" is possible,
"export a snapshot on exit" is not, only what was accumulated through the events.

### 4. "File viewed" marks and changeset labels — **NO / YES**

- **Viewed marks — NO.** Not one of the 84 built-in commands (`hunk.review.*`, `hunk.view.*`,
  `hunk.app.*`, `hunk.history.*`) has anything like `markViewed`/`toggleReviewed`.
  `ExtensionReviewSnapshotFile` has `changeKind`, `stats`, `flags{untracked,binary,tooLarge,partial}`,
  `contentIdentity` — and no viewed status at all. The only occurrence of `reviewedFileIds`
  in the bundle is a local variable of file-view reconciliation, not a feature. There is only
  "by annotated" navigation: `nextAnnotatedFile`, `nextAnnotatedHunk`.
- **Changeset labels — YES.** `sourceLabel` + `title` from the adapter make it both to the UI
  and to `session get/list/review --json`. Verified: `"title": "Ход T2 («вынеси конфиг»)"`
  (recorded fixture data: "Turn T2 ('extract the config')").
  But this is the label of the **current** changeset; there is no built-in switcher/list of turns —
  we will have to build it ourselves (item 1).

### 5. Startup time and width <100 — **~0.4 s (with a caveat) / not verified**

| Measurement | Median |
|---|---|
| `hunk --version` via the Node shim | 102 ms |
| `hunk --version` via the binary directly | 78 ms |
| TUI start → session registered with the daemon (4 runs) | **424 ms** (min 397, max 459) |

A caveat that matters for honesty: the measurement went through a `script` pty that **does not answer**
the terminal's capability queries (`\x1bP+q4d73`, `\x1b_Gi=31337…` are visible in the stream). For
tuicr the same harness gave 3.1 s with 80 ms of real work — that is, what gets measured is mostly the
response-wait timeout. So 424 ms is a **ceiling**; in a live terminal it will be less. The exact number
must be taken in a real terminal (see below).

Width <100 columns cannot be checked in a pty without geometry — a question for the live run.

## Remaining to check live (a real terminal is needed)

> **Amendment (T5, 2026-09-14, live run):** the `--no-update-check` flag does **not exist**
> in hunk 0.22.0 — the commands below must be invoked without it. Width <100 columns and the
> turn-switching keys have since been verified live in T7 (PLAN.md journal); range
> selection `v` in the UI has still not been checked.

```bash
# 1. Does it render at all on Node 22 / this terminal + width
hunk diff --no-update-check          # in a repo with changes; narrow the window to ~90 and ~70 columns

# 2. A range comment by hand: v (visual) -> select 2-3 lines -> start a note
#    then from another window:  hunk session comment list --repo . --type user --json
#    the question is whether oldRange/newRange wider than one line arrives

# 3. Time to first render in a real terminal
time hunk diff --no-update-check     # and exit immediately with q
```

## Verdict on hunk

| Question | Verdict |
|---|---|
| 1. Arbitrary changeset not from git | **YES** — `registerVcsAdapter`, verified with a working extension in a non-git directory |
| 2. Ranges / old side / editing | old side **YES**; ranges in the model **YES**, in the CLI **NO**, in the UI — probably yes; editing/deletion **YES** |
| 3. Reading comments after exit | **NO** natively; **YES** via our own extension (`note_changed` + `shutdown`) |
| 4. Viewed marks / changeset labels | viewed **NO**; labels **YES** |
| 5. Startup / width | ≤ ~0.4 s (a ceiling, the harness inflates it); width not verified |

The Extension API turned out to be **deeper** than DESIGN.md assumed, and the main risk of option A is
retired. But two new costs appeared: comments do not survive exit (our own mirror extension is needed)
and viewed marks do not exist at all. Plus the API is marked experimental: "may change in breaking ways
between minor releases".

## Artifacts

- `/tmp/hunk-spike/ext/index.ts` — the spike extension (own VCS + note mirror)
- `/tmp/hunk-spike/out/log.txt`, `notes-live.json`, `notes-shutdown.json` — spike output
- `hunkdiff@0.22.0` installed globally; state in `~/.hunk/`, `~/.config/hunk/state.json`
