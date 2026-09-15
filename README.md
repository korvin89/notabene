# notabene

Terminal diff review for Claude Code: `!ntb` right from the session opens the
current turn's changes (or any previous turn's — labeled with snippets of your
prompts) in the [hunk](https://hunk.dev) viewer, you leave inline comments, and
the batch travels back into the agent's context — it responds point by point and
makes the edits.

How it works — [ARCHITECTURE.md](ARCHITECTURE.md), why it works this way — [DECISIONS.md](DECISIONS.md).

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/korvin89/notabene/main/install.sh | sh
```

Requirements:

- **Node ≥ 22.18** in `PATH` — it runs the TypeScript directly, there is no build step
- **git** — the installer clones, and updates are git tags
- **npm** — one `npm ci` for the pinned viewer (~100 MB, the slow part of the install)
- **macOS** — the paths to kitty and to the viewer binary assume the macOS layout

The installer puts the source in `~/.local/share/notabene` and symlinks
`~/.local/bin/{ntb,notabene}` at it; if that bin directory is not on your `PATH`,
it prints the line to add. It refuses rather than overwrites: a directory it did
not create, or a foreign `ntb` already in the bin directory, stops it with a
message. `sh install.sh --help` lists the flags that change any of this:
`--root`, `--bindir`, `--repo`, `--ref`.

Prefer to read before running? `curl -fsSL <url>/install.sh -o install.sh`, read
it, then `sh install.sh`.

### Updating

```sh
ntb update         # move to the newest release
ntb update --check # only report whether there is one
```

Re-running `install.sh` does the same thing. Releases are git tags, so updating is
git plus `npm ci` — no background checks, no telemetry, nothing to opt out of.
Both refuse to touch a directory without the installer's `.managed-install`
marker, so a development checkout can never be clobbered by an update; update
that one with git yourself.

Run `update` in a normal terminal, not as `!ntb update`: a `!`-command is cut
loose after ~2 minutes, and the dependency download can outlast that.

Versions are SemVer and still below 1.0, which means a minor bump may change
behaviour you rely on; every release is a `vX.Y.Z` tag with notes on the
[releases page](https://github.com/korvin89/notabene/releases) and in
`CHANGELOG.md`. There are no pre-releases, and a published tag is never moved —
if a release turns out broken, the fix is the next one. To pin a version:

```sh
sh install.sh --ref v0.2.0                      # from a downloaded script
curl -fsSL <url>/install.sh | sh -s -- --ref v0.2.0   # or straight through the pipe
```

### In the repositories you review

Add to `.gitignore`:

```
.claude/reviews/
```

— that's where machine-readable review copies and review-session files go. The
directory won't get into the diff even without this line (`ntb` always excludes
it), but otherwise it will keep asking to be committed.

### One-time kitty.conf edit (for the "single command" flow in kitty)

`kitty @` from under a `!`-command works only through a socket — add two lines
to `~/.config/kitty/kitty.conf` and **fully restart kitty** (a config reload
does not pick up `listen_on`):

```
allow_remote_control socket-only
listen_on unix:/tmp/kitty
```

`socket-only` is safer than `yes`: control is accepted only via the socket,
escape sequences in the terminal don't get it. Until the lines are there,
`ntb` will offer the two-step fallback itself.

## Usage

### Single command (Claude Code in kitty or in a Herdr pane)

In a Claude Code session:

```
!ntb
```

The rest depends on the environment: in kitty a tab with the diff opens, in
Herdr — an adjacent pane. The pane deliberately stays open after the review: the
next `!ntb` finds it by the name "notabene" and reloads it instead of
spawning more splits (don't need it — close it by hand, the next run recreates
it). In the viewer: `c` — comment, `<` / `>` / `T` — turn switching
(Current / T1..Tn with prompt snippets), `q` — quit. After quitting, the batch
is printed to stdout and lands in the context — Claude responds to each item.

Reviewing a specific turn: `!ntb --turn 3` (or `--turn T3`).

Comment types — via a prefix in the body: `[q]` question, `[b]` blocker, no
prefix (or `[c]`) — change; the full words `[question]` / `[blocker]` /
`[change]` work too. In the batch, types are printed as full words.

Example batch (this is exactly what Claude receives):

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

An empty review (no changes or no comments) — empty stdout, Claude does nothing.

### Two steps (any terminal, fallback path)

When neither kitty with remote control nor Herdr is detected (or with an
explicit `--launcher manual`):

```
!ntb                    # prepares the review, prints instructions
```

then in any other terminal:

```
ntb open                # the viewer right here; comments, q
```

and back in the session:

```
!ntb collect            # the batch travels into the context
```

### Commands and flags

```
ntb [review]    review the current turn — the default, so `!ntb` is enough
ntb open        only prepare and open the viewer (step 1 of the "two steps")
ntb collect     collect the opened viewer's comments (step 2)
ntb update      update this install to the newest release
ntb dump WHAT   debugging: current | turns | session | env
```

Flags belong to the command that uses them; anywhere else they are a usage error.

```
review, open:          --turn N        the turn T<N> diff, not the current state
                       --launcher NAME herdr | kitty | manual — bypass detection
                       --timeout MIN   viewer wait time (default 30)
review, open, collect: --context       add context lines to batch items
update:                --check         report only, change nothing
everywhere:            --verbose       diagnostics to stderr
                       -h, --help      help
                       -V, --version   version
```

## MVP limitations

- **A review longer than ~2 minutes becomes asynchronous.** Claude Code waits
  120 s for a `!`-command, then moves it to the background ("moved to the
  background") — that's fine: the viewer stays open, and after quitting a
  background-task-completed notification arrives, from whose file Claude reads
  the batch on its own (verified live). If Claude didn't read the file — just
  ask: the batch and the path to the JSON copy are in the task file (re-running
  `!ntb collect` won't help, pending is already cleared). Strict synchrony
  can be had by raising `BASH_DEFAULT_TIMEOUT_MS` in the `env` of your
  `settings.json`, but that affects all `!`-commands and the Bash tool.
- **Comments left after switching turns** (`<`/`>`/`T`) end up in the batch
  under the original turn's header — the `file:line` anchor stays true to its
  own turn, but the batch header doesn't change.
- **One review per repository at a time.** Review-session files are shared; a
  second `!ntb` on top of an unfinished one gets a refusal with a hint —
  `!ntb collect` first.
- **Everything is computed from the git repository root**, not the session
  directory: `.claude/reviews/` lives there, batch paths (`@pkg/deep/file.ts`)
  come from there — exactly as git itself prints them. If Claude Code runs in a
  subdirectory, references have to be read relative to the repository root.
- **No "file viewed" marks** (hunk doesn't support them; deliberately cut from
  the MVP).
- A batch longer than ~25k characters is not trimmed by comments — only context
  lines get cut; an extra-long batch may end up in the background-task file,
  Claude reads it from there.
- The Claude Code JSONL/file-history format is officially internal: on schema
  drift, per-turn degrades to Current with a warning.

## Development

Work from a plain clone, not from an install: without the `.managed-install`
marker `ntb update` refuses to touch it, which is what you want.

```sh
git clone https://github.com/korvin89/notabene.git && cd notabene
npm install       # the pinned hunkdiff (the viewer) plus dev dependencies
./ntb --version   # sanity check

npm test          # node --test, e2e via the real ./ntb
npm run typecheck # tsc --noEmit
```

Output contract: stdout receives **only** the final comment batch (Claude reads
it) — all diagnostics go to stderr; the invariant is guarded by
`test/stdout-contract.test.ts`.
