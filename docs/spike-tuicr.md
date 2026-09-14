> References of the form "DESIGN.md §N" below point to the original design document:
> on 2026-09-14 it was folded into [ARCHITECTURE.md](../ARCHITECTURE.md) and
> [DECISIONS.md](../DECISIONS.md). The experiment text is left as is.

# T1c — tuicr spike

> Translated from the Russian original on 2026-09-14; the protocol content is preserved as recorded (DECISIONS.md D23).

Date: 2026-09-13. Version: **tuicr 0.25.0**, MIT, **Rust**,
[agavra/tuicr](https://github.com/agavra/tuicr) — 3111 ★, last push two days before the spike.
The ticket's budget is an hour, superficial. In fact tuicr turned out **stronger than hunk** on three
of the five questions, so I dug a bit deeper.

## How it was verified

The same harness as in [spike-hunk.md](spike-hunk.md): an isolated pty via `script`, the user's
terminal was not touched. The binary was downloaded as a release into `/tmp/tuicr-spike/` — **not
installed globally**, the system was not touched; the test sessions in
`~/Library/Application Support/tuicr` were deleted after the spike (the directory did not exist before
the spike).

```bash
curl -sSL .../v0.25.0/tuicr-0.25.0-aarch64-apple-darwin.tar.gz | tar xz    # 6 MB, a static binary
```

Installing "the proper way": `brew install tuicr`, `cargo install tuicr` (cargo 1.96 is on the
machine), `curl -fsSL tuicr.dev/install.sh | sh`, mise, nix.

## The same five questions

### 1. Arbitrary changeset (old/new pairs NOT from git) — **NO**

The weak spot, and the only serious one.

- **No plugins at all.** `tuicr --help` / `tuicr review --help`: only `tui`, `pr`, `review`,
  `update`. No extension API, no VCS backends, no changeset transforms.
- **A patch is not accepted from stdin** — there is no analogue of `hunk patch -`.
- The diff sources are hard-wired: git / jj / mercurial (working tree, revisions) + PRs/MRs
  from forges.
- `--file <PATH>` — "Open a file or directory for annotation (**no VCS required**)" — works,
  verified in a non-git directory (slug `novcs@~file/worktree/file`), but that is **annotating a file,
  not a diff of two versions**. Not suitable for per-turn.
- There is a Rust library API (`ReviewStore`: `list_sessions_for_repo`, `add_comment` with
  `CommentTarget::Line|Range|File|Review`) — but it is about **sessions and comments**, not the diff
  source, and requires writing Rust.

**The workaround:** a shadow git repository per turn. We put the "before the turn" version of the
files in as a commit, the "after" version into the working tree, and run `tuicr -w` there. The paths
inside the shadow repo are made the same as in the real one, so that the `@path:line` anchors are
correct. It works (our fixture is exactly that), but it is a crutch: `e`/`:edit` will open the shadow
file, not the real one, and every turn needs its own repo.

### 2. Comments: ranges / old side / editing — **YES, fully**

Better than hunk. Verified via `tuicr review add` on a live session:

| What | Command | Result (`location`) |
|---|---|---|
| line | `--target-file weapons.ts --line 2 --side new --type issue` | `weapons.ts:2` |
| **range** | `--line 2 --end-line 3 --side new` | `weapons.ts:2-3` |
| **old side** | `--target-file balance.md --line 2 --side old` | `balance.md:2 [old]` |
| whole file | `--target-file extra.txt` | `extra.txt` |
| whole review | (without `--target-file`) | `review` |
| JSON from stdin | `--input -` with `{"start_line":1,"end_line":2,…}` | `weapons.ts:1-2` |

In the UI: `c`/`C` — a comment on a line/file, **`v`/`V` — visual mode for a range**,
`:summary` — a list of all drafts with navigation and editing.

**Comment types — out of the box**, and this directly closes the spec requirement that DESIGN.md §4
proposed cutting first. In the config:

```toml
[[comment_types]]
id = "issue"
color = "red"
definition = "must fix before merge"
```

The output has a `comment_type` field (verified: `issue`, `suggestion`, `none`); the markdown export
has a `[TYPE]` tag. So `question/change/blocker` from the spec are set up via the config, with no code.

### 3. Reading comments from outside after exit — **YES**. Natively, no hacks

Here tuicr beats hunk outright.

Sessions **persist to disk** in `~/Library/Application Support/tuicr/reviews/sessions/*.json`
and live between runs. Verified literally: 6 comments → `kill` the process →

```bash
tuicr review list --repo .        # -> comment_count: 6, reviewed_count: 0, file_count: 3
tuicr review comments --session repo@main/staged-and-unstaged/bb644fe
```

returns JSON whose fields are almost one-to-one with our schema from DESIGN.md §3.2:

```json
{ "id": "183388a0-…", "location": "balance.md:2 [old]", "path": "balance.md",
  "start_line": 2, "end_line": 2, "side": "old", "comment_type": "none",
  "lifecycle_state": "local_draft", "created_at": "2026-09-13T18:40:32…",
  "content": "Почему убрали пункт про крит?" }
```

(The Russian `content` is recorded fixture data: "Why was the crit item removed?")

Plus mechanics that might as well have been written for our wrapper:

- at startup, **before entering the alternate screen**,
  `tuicr-session: repo@main/staged-and-unstaged/bb644fe` is printed to **stderr** — the wrapper only
  needs to capture stderr to get the session identifier;
- at exit, **always**, `tuicr-summary: reviewed 3/3 files, 2 comments added` is printed to stderr —
  immediately distinguishing "looked, no remarks" from "left without looking" (in the spec that is
  "an empty review → empty stdout");
- empty auto-created sessions delete themselves on exit;
- `tuicr review list` marks live sessions with `"active": true` (in my pty run the field stayed
  `false` — possibly a harness artifact, immaterial for the MVP).

### 4. "File viewed" marks and changeset labels — **YES / partially**

- **Viewed marks — YES, and with persistence.** `r` — file viewed, `R` — hunk viewed,
  "Review tracking at file or hunk granularity, **persisted across sessions**". The
  `review list` output has `reviewed_count`, and `tuicr-summary` has `reviewed 3/3 files`. hunk has
  none of this at all.
- **Labels/switcher** — weaker. There is a review-target selector with a **Sessions** tab
  (`:sessions` / `Tab`) listing the saved reviews of the current checkout — with shadow repos per
  turn it could become a T1..Tn switcher, but the labels would be slugs like
  `repo@main/staged-and-unstaged/bb644fe`, not "turn T3 ('fix the dagger balance')".
  There is nothing to set your own labels with.

### 5. Startup time and width <100 — **~80 ms / not verified**

tuicr has a built-in profiler (`TUICR_PROFILE=1`), and it settled the question:

```
startup.parse_cli_args        78 µs
startup.load_config          175 µs
startup.resolve_theme       1.02 s     <- waiting for the terminal's reply to OSC 11 (background)
startup.app_init            79.8 ms
  ├ detect_vcs              64.4 ms
  ├ syntax_highlighter        960 µs
  └ diff.load_working_tree  13.8 ms  (files=3)
```

**The real work is 80 ms.** `tuicr --version` — 5 ms (a static Rust binary without a runtime).
The seconds in `resolve_theme` and the 3.1 s observed from outside before the alternate screen are
timeouts of capability queries in my fake pty, which has nobody to answer them; in a real terminal the
reply comes instantly. The same artifact inflates hunk's number too.

Width <100 — a question for the live run.

## Remaining to check live

```bash
tuicr -w --no-update-check     # in a repo with changes; narrow the window to ~90 and ~70 columns
# inside: v -> select lines -> c -> comment; r -> mark the file viewed; y / :summary
time tuicr -w --no-update-check   # and immediately q
```

## Side finding: `joelazar/pi-tuicr`

[pi-tuicr](https://github.com/joelazar/pi-tuicr) turned up — "Review the changes pi made in tuicr,
then send the review comments back to pi". This is **exactly our task**, but for a different agent and
without a per-turn source. Plus `xendarboh/tuicr.nvim`. So the model "tuicr as the viewer + a thin
wrapper returning the comments to the agent" has already been walked by someone — worth looking at
their code in T5, but it is no competitor to the spec (no source from Claude Code history, no launch
via `!`).

## Verdict on tuicr

| Question | Verdict |
|---|---|
| 1. Arbitrary changeset not from git | **NO** — no plugins, no patch from stdin; only a shadow git repo per turn |
| 2. Ranges / old side / editing / types | **YES, everything**, including comment types out of the box |
| 3. Reading comments after exit | **YES, natively** — persistent sessions + `review comments --json` |
| 4. Viewed marks / labels | viewed **YES** (and persistent); own turn labels **NO** |
| 5. Startup / width | **80 ms** of real work; width not verified |

The DESIGN.md §2.2 assessment ("the closest competitor, needs a spike, plan B") is an underestimate:
against the spec requirements tuicr closes more than hunk does — except for the one item that is
central for us.
