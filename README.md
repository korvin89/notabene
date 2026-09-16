# notabene

Terminal diff review for Claude Code: `/ntb` right from the session opens what
the agent changed in the [hunk](https://hunk.dev) viewer — the working tree, the
index, or everything since your branch left `main` — you leave inline comments,
and the batch travels back into the agent's context, where it responds point by
point and makes the edits.

How it works — [ARCHITECTURE.md](ARCHITECTURE.md), why it works this way — [DECISIONS.md](DECISIONS.md).

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/korvin89/notabene/main/install.sh | sh
```

Requirements:

- **Node ≥ 22.18** in `PATH` — it runs the TypeScript directly, there is no build step
- **git** — the installer clones, and updates are git tags
- **npm** — one `npm ci` for the pinned viewer, the slow part of the install
- **macOS** — the paths to kitty and to the viewer binary assume the macOS layout

The installer puts the source in `~/.local/share/notabene` and symlinks
`~/.local/bin/{ntb,notabene}` at it; if that bin directory is not on your `PATH`,
it prints the line to add. It refuses rather than overwrites: a directory it did
not create, or a foreign `ntb` already in the bin directory, stops it with a
message. `sh install.sh --help` lists the flags that change any of this:
`--root`, `--bindir`, `--repo`, `--ref`.

Prefer to read before running? `curl -fsSL <url>/install.sh -o install.sh`, read
it, then `sh install.sh`.

### The plugin

The installer brings the CLI; `/ntb` comes from the Claude Code plugin, which is
a separate step:

```
/plugin marketplace add korvin89/notabene
/plugin install ntb@notabene
```

Two installs for one tool is a wart we have not yet collapsed. You can skip the
plugin and drive everything with `!ntb` — but then a review that outlasts the
wait needs you to write to the agent yourself, because a `!`-command cannot wake
it (see "Two ways in" below).

The first `/ntb` asks permission to run `ntb`; approve it once. In Claude Code's
automatic permission mode the request may be refused outright by the classifier
rather than shown to you — allow `Bash(ntb:*)` in your `settings.json` if that
happens.

### Updating

```sh
ntb update         # move to the newest release
ntb update --check # only report whether there is one
```

Both also report the state of the **plugin**, which updates by its own path and
so drifts from the CLI: if it is missing you get the two lines that add it, and
if it is behind on a release that actually changed the skill, the lines that
catch it up. When neither is true they say nothing about it — a version gap on
its own is not worth a word, since every release bumps the plugin's version
whether or not the skill moved.

```
/plugin marketplace update notabene
/plugin update ntb@notabene
```

A plugin update applies only after Claude Code is **restarted** — that is Claude
Code's rule, not ours, which is also why `ntb update` reports the plugin instead
of updating it for you.

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

Nothing. `ntb` writes nothing into the repository: review state and the
machine-readable copies live in `~/.claude/notabene/<project>/`, next to
Claude Code's own per-project data. No `.gitignore` line, nothing to commit by
accident, nothing for a file watcher to react to.

If you reviewed with `ntb` 0.2.x or earlier, the first run moves the old
`.claude/reviews/` out of the repository and removes the directory — including
an unfinished review, so a viewer left open before the upgrade still delivers
its comments.

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

### Two ways in

In a Claude Code session, either `/ntb` — the agent runs the review itself and
waits for you — or `!ntb`, where you run it and the output reaches the agent as
part of your next message. Same viewer, same batch; they differ only in what
happens when the review runs long, which it usually does. Past the caller's
timeout Claude Code detaches the command without killing it, and then:

- after `/ntb` the command belongs to the agent. Quitting the viewer wakes it
  through the task-completion notification and the batch is delivered with
  **nothing asked of you** (verified live, DECISIONS.md D29);
- after `!ntb` the command belongs to you, and there is no agent turn to return
  to. The batch waits until you write to the agent — telling it you are done is
  enough.

That difference is why the plugin exists. Everything below applies to both.

The rest depends on the environment: in kitty a tab with the diff opens, in
Herdr — an adjacent pane. The pane deliberately stays open after the review: the
next `!ntb` finds it by the name "notabene" and reloads it instead of
spawning more splits (don't need it — close it by hand, the next run recreates
it). In the viewer: `c` — comment, `<` / `>` / `T` — switch scope (see below),
`C` — complete the review, `x` — cancel it, `q` — quit. The finishing keys are
repeated in the menu bar next to the scope's name, and all of them sit in the
`F10` menu under Extensions. Completing and quitting do the same thing: the batch
is printed to stdout and lands in the context, and Claude responds to each item.
Cancelling is the way out with nothing delivered — it asks first if you have
already written comments, and then the review is gone: no batch, no JSON copy.

### What gets reviewed

A run offers every scope that applies to your repository right now, and the
viewer switches between them with `<` `>` `T` — no relaunch, which matters
because with `/ntb` it is the agent that starts the review and you who decides
what to look at:

| Scope | What it is | When it shows up |
|---|---|---|
| Working tree | `git diff HEAD` plus untracked files | always |
| Staged | the index against `HEAD` | when something is staged |
| Since `<base>` | from where your branch left the base branch up to the working tree — committed or not | on a branch with commits of its own |

The base branch is whatever `origin/HEAD` names, falling back to `main` then
`master`. The one that opens first is the working tree, or — on a clean tree —
whatever else has changes, so committed branch work is never answered with
"No changes".

From the command line you can say which one opens first, and ask for a
comparison that is not on offer by default:

```sh
!ntb                 # the working tree
!ntb --staged        # the index
!ntb main            # everything since this branch left main
!ntb HEAD~3 HEAD     # two revisions, nothing uncommitted
```

Comment types — via a prefix in the body: `[q]` question, `[b]` blocker, no
prefix (or `[c]`) — change; the full words `[question]` / `[blocker]` /
`[change]` work too. In the batch, types are printed as full words.

Example batch (this is exactly what Claude receives):

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

An empty review (no changes or no comments) — empty stdout, Claude does nothing.

### Two steps (any terminal, fallback path)

When neither kitty with remote control nor Herdr is detected (or with an
explicit `--launcher manual`):

```
!ntb                    # prepares the review, prints instructions
```

then in any other terminal:

```
ntb open                # the viewer right here; comments, then C (or q)
```

and back in the session:

```
!ntb collect            # the batch travels into the context
```

### Commands and flags

```
ntb [review]    review the changes — the default, so `!ntb` is enough
ntb open        only prepare and open the viewer (step 1 of the "two steps")
ntb collect     collect the opened viewer's comments (step 2)
ntb update      update this install to the newest release
ntb dump WHAT   debugging: scopes | session | env
```

Flags belong to the command that uses them; anywhere else they are a usage error.

```
review, open:          REV [REV]       the scope to open first (see "What gets reviewed")
                       --staged        the index against HEAD
                       --launcher NAME herdr | kitty | manual — bypass detection
                       --timeout MIN   viewer wait time (default 240)
review, open, collect: --context       add context lines to batch items
update:                --check         report only, change nothing
everywhere:            --verbose       diagnostics to stderr
                       -h, --help      help
                       -V, --version   version
```

## MVP limitations

- **A long review becomes asynchronous.** The detach ceiling is the caller's, not
  ours: 120 s for `!ntb`, ten minutes for `/ntb` (the Bash tool's maximum). Past
  it the command is moved to the background but not killed — the viewer stays
  open and the batch ends up in the task file. After `/ntb` the agent is woken by
  the completion notification and reads it; after `!ntb` nothing wakes it, so
  tell it you are done. If it still hasn't read the file, just ask: the batch and
  the path to the JSON copy are both in there (re-running `ntb collect` won't
  help, pending is already cleared). For `!ntb`, strict synchrony can be bought by
  raising `BASH_DEFAULT_TIMEOUT_MS` in the `env` of your `settings.json`, but that
  affects every `!`-command and the agent's Bash tool.
- **Comments left after switching scope** (`<`/`>`/`T`) end up in the batch under
  the scope the review opened on — the `file:line` anchor is its own, correct
  one, but the batch header doesn't change.
- **One review per repository at a time.** Review-session files are shared; a
  second run on top of an unfinished one gets a refusal with a hint — `ntb
  collect` first. The viewer wait is 4 hours by default, so a viewer opened and
  forgotten keeps refusing for that long; `collect` ends it at any point.
- **Everything is computed from the git repository root**, not the session
  directory: batch paths (`@pkg/deep/file.ts`) come from there — exactly as git
  itself prints them — and so does the key under which the review state is
  stored. If Claude Code runs in a subdirectory, references have to be read
  relative to the repository root.
- **No "file viewed" marks** (hunk doesn't support them; deliberately cut from
  the MVP).
- A batch longer than ~25k characters is not trimmed by comments — only context
  lines get cut; an extra-long batch may end up in the background-task file,
  Claude reads it from there.
- **Scopes overlap, and the viewer gets the full text of both sides of every
  file in each of them.** On a long-lived branch "Since main" can make the
  hand-off file several megabytes; it is deleted as soon as the review ends.

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
