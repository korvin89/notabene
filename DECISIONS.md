# notabene: decision log

What was decided, why, and what backs it up. The current system design is in
[ARCHITECTURE.md](ARCHITECTURE.md).

**An entry earns its place only if a future reader would decide differently
because of it.** Three kinds qualify: a live-verified fact that contradicts the
documentation or plain intuition; an alternative rejected with the measurement
that killed it; an invariant whose reason is not visible in the code. A record of
what was renamed, moved, or translated is not a decision — the current state
already says that, and the entry only rots. Backlogs live in
[`plans/`](plans/), not here. `.claude/skills/decision/` has the full checklist.

Until the first push there is no published history, so entries may still be
consolidated and names normalised. **From the first push the log becomes
append-only**: a revisited decision keeps its old entry, marked as revoked, and a
new one references it.

Primary records of the experiments live in [`docs/`](docs/) — `spike-hunk.md`,
`spike-tuicr.md`, `spike-tty.md` — and the probes they ran are in
[`scripts/`](scripts/).

---

### D1. Stack: a thin wrapper around hunk, TypeScript / Node 22
2026-09-13 · in effect

We don't write our own TUI; the viewer is off-the-shelf — hunk 0.22.0 (the
`hunkdiff` package, MIT).

**Why.** Four options were considered: a wrapper around hunk (A), our own TUI in
Go/Rust (B), `prr`-style minimalism — diff in `$EDITOR` (C), a wrapper around tuicr (D).
The spikes showed that against the spec requirements tuicr covers more items (ranges,
comment types, viewed marks, comments survive exit, `--stdout`), but
**misses the main one**: there is no way to feed it an arbitrary non-git changeset —
only shadow git repositories per turn, and turn labels cannot be set.
hunk has an Extension API with `registerVcsAdapter` — verified with a working
extension in a non-git directory. The per-turn changeset is the product, hence A.
Our own TUI is weeks of work for what both viewers already do well.

**Consequences.** What hunk can't do, we add ourselves: comments don't survive
daemon exit → our own mirror extension (D19); no comment types → prefixes
(D8); no viewed marks → cut (D9). The Extension API is marked experimental,
so the version is pinned exactly (D20). Plan B if the API breaks: tuicr + shadow
repositories. Details — `docs/spike-hunk.md`, `docs/spike-tuicr.md`.

### D2. No build: Node 22 executes TypeScript directly
2026-09-13 · in effect

`ntb` is an sh script that calls `node src/cli.ts`. No `dist/`, no bundler.

**Why.** Node 22.18+ strips types by default (measured: 30–40 ms startup,
stderr clean). After `git clone` everything works as is, "forgot to rebuild" is
impossible, and `!ntb` must run without a global install.

**Consequences.** Code must be erasable: `erasableSyntaxOnly`, no `enum` or
`namespace`, imports with the `.ts` extension. Zero runtime dependencies (except hunk);
`node_modules` is needed only for `tsc` and the viewer. Tests — `node --test`.

### D3. TTY is unavailable under `!` → the viewer lives outside the `!`-command
2026-09-13 · in effect · revokes the original "fzf model"

**Why.** The probe showed that a `!`-command **has no controlling terminal**:
`open("/dev/tty")` → ENXIO, all three streams are pipes. Claude Code detaches the
command from the terminal rather than merely redirecting output. The original
assumption (the TUI draws to `/dev/tty`, stdout stays reserved for the batch) is
unworkable.

**Key to the workaround.** The `!`-command is **synchronous**: we can show the
changeset to a viewer living elsewhere, block, and collect the comments after it
exits. Both the bundled hunk skill and the reference `herdr-hunk-diff` work this way.

**Consequences.** The `Launcher` abstraction appeared (`open`/`waitForDone`/`collect`).
As a side effect, the viewer outlives the `!`-command and can be returned to.
Details — `docs/spike-tty.md`.

### D4. Three flows: Herdr → kitty → manual, chosen by env detection
2026-09-13 · in effect

A chain of strategies with env-based autodetection; `manual` closes the chain and
always succeeds.

**Why.** The user's machine has both Herdr 0.9.0 and kitty 0.48.2 without a
multiplexer — both paths are needed. `manual` (two commands, `open`/`collect`)
is barely extra work: "read the mirror and print the batch" is needed
by all three flows.

**Consequences.** Detection is by environment variables only, without spawning
processes: it happens on every `!ntb` and must be free. Whether a path actually
works is discovered on the first call (kitty returns an exit code, herdr — structured JSON).

### D5. kitty: wait by polling the window, not `--wait-for-child-to-exit`
2026-09-14 · in effect · revokes the mechanism from D4

**Why.** The flag worked in the probe (2 s, code 0), but on a live product run the
`kitten @` client with it **stopped returning control at all** — reproduced
with an `sh -c 'sleep 1'` dummy for every launch type: the child finished, the tab
closed, the client was still alive 40 s later. Symptom: `!ntb` never finished
and reacted neither to the timeout nor to Ctrl-C, because the wait sat inside
someone else's hung process.

**Replacement.** `launch` without the flag returns the window id, then we poll
`kitty @ ls --match id:<wid>`. The cost — the viewer's exit code is lost, so
"failed to start" is recognized by the heuristic "the window vanished within <3 s
and there is no mirror". The gain — the timeout and Ctrl-C are back.

**Consequence for tier neighbors.** The argument "kitty is the best case, it has
blocking built in" no longer holds: the wait code is now exactly what
wezterm or iTerm would have needed.

### D6. No launching of a separate terminal instance (tier 3)
2026-09-13 · in effect

Tiers: 1 — multiplexer (we do), 2 — terminal remote control (kitty
only), 3 — our own terminal instance as a child process (**we don't**), 4 — launch
nothing (we do).

**Why.** The only terminals on the machine are kitty and iTerm (plus Terminal.app), so
tier 3 covers nothing beyond tier 2 and flow C. iTerm and Terminal.app would
each need their own adapter anyway (AppleScript / `it2api`). On macOS it also means
a separate window instead of a tab and a second application instance. A trap for the
future: `open -W` won't do for waiting — it waits for the whole application to quit.

### D7. Per-turn diff is built from file-history, not by replaying edits
2026-09-13 · in effect

**Why.** The JSONL has a ready-made file-history mechanism: snapshots at turn
boundaries and full copies of file versions. This is more robust than replay: it
includes subagent edits and survives manual edits. Replay from `toolUseResult`
remains the second echelon, degradation to Current — the third.

**What real sessions revealed.** `trackedFileBackups` is cumulative — "what the
turn touched" is computed by comparing adjacent snapshots by `backupFileName`, not
by set size (a common mistake). The "before" state of a file's first edit lies in
its delta's `@v1` backup. The hash in a backup name is not stable per path across
versions. Turn numbering diverges from the built-in `/diff`, so the turn label must
contain a prompt snippet. Details — ARCHITECTURE.md §4.3.

### D8. Comment types — as a prefix in the body
2026-09-13 · in effect

`[q]`/`[question]` → question, `[b]`/`[blocker]` → blocker, no prefix or
`[c]` → change.

**Why.** hunk has no comment types at all, while the `type` field in the spec's
schema had to be in place from day one. A prefix is the only way to set a type from
a UI that doesn't exist.

### D9. "File viewed" marks are cut from the MVP
2026-09-13 · in effect

hunk doesn't have them — all 84 built-in commands and the snapshot schema were
checked, so there is nothing to re-look-for. Emulating them is separate work on
top of the extension pane; we'll come back if it starts to hurt.

### D10. Machine-readable copies go to `<repo>/.claude/reviews/`, no rotation
2026-09-13 · in effect

**Why.** Next to the repository (easy to find, easy to delete), one line in
`.gitignore`. The copies are tiny (0.5–1.2 KB) and form the only review
history, so they are not rotated. Session housekeeping files in the same directory
are cleaned up — D16.

### D11. Outside a git repository — a warning, not an error
2026-09-13 · in effect

Current compares the working tree with HEAD; without a repository there is nothing
to show → `log.warn` and an empty changeset list. Per-turn still works
independently of git. An empty list is a valid answer, not a failure.

### D12. Wait timeout is 30 minutes; the `!` ceiling is left alone
2026-09-14 · in effect

**Why.** The `!`-command ceiling is 120 s (the `BASH_DEFAULT_TIMEOUT_MS` default);
after that it is "moved to the background", but the process is not killed. Trimming
our timeout to fit under 120 s would be harmful: it would cut off a normal review.
Raising `BASH_DEFAULT_TIMEOUT_MS` globally was also rejected — it would affect all
`!`-commands and the Bash tool.

**Confirmed live.** The viewer was kept open for >120 s: at second 120 the command
went to the background, a notification arrived after exit, and the agent read the
batch from the task file on its own, in full and verbatim. So the batch header
needs no change. The residual risk ("the agent didn't read the file") is described
in the README.

### D13. One review per repository: refusal instead of silent overwrite
2026-09-14 · in effect

There is one handoff and one mirror per repository, so a second `!ntb` on top of
an unfinished session would wipe the open viewer's comments. Now — exit code 1
with a hint about `collect`. A failed viewer launch leaves no session behind:
pending is removed, otherwise it would block all subsequent runs.

### D14. The review root is the git repository root, not the session cwd
2026-09-14 · in effect

**Why.** `git diff` prints paths from the repository root, while the housekeeping
files, `handoff.root`, and batch references used to be computed from the session
cwd. For a session started in a subdirectory this diverged: `.claude/reviews/`
ended up in the subdirectory, `handoff.root` didn't match the patch paths, the
batch reference didn't resolve. Reproduced on a test bench.

**Cost.** Batch references are always relative to the repository root: with a
session in a subdirectory they are read relative to the root. Recorded in the README.

### D15. Comment mirror: unique name, continuation, atomic writes
2026-09-14 · in effect

Three fixes to one mechanism: the name is `notes-<createdAt>.json` (a viewer left
open writes to its own mirror and doesn't corrupt the next review); on load the
extension **seeds** its state from an existing mirror instead of zeroing it (a
repeated `ntb open` no longer loses comments already entered); writes go
through a temporary file and `rename` (truncated JSON used to read as "there were
no comments").

### D16. Session artifacts are deleted when the session closes
2026-09-14 · in effect

`finish()` removes `pending.json`, `handoff.json`, and the mirrors — both when the
batch is delivered and when there turned out to be no comments. The handoff was the
heaviest file in the directory: 116 KB for a single four-file changeset, megabytes
with the turn switcher (it contains the full texts of both sides). Machine-readable
copies remain (D10).

### D17. Review housekeeping files don't end up in their own diff
2026-09-14 · in effect

`.claude/reviews/` is dropped from the current diff regardless of the user's
`.gitignore`. Otherwise the previous run's handoff became an untracked file of the
next one and its text ended up in the new handoff's `newText`: measured — 650 B → 16,913 B
over four runs.

### D18. The Herdr pane is not closed after a review
2026-09-13 · in effect

We reuse it by the name `notabene`: from the second run onward the pane simply
reloads instead of multiplying splits. `pane close` is deliberately not called.
Closing it by hand is fine — the next run will create it anew.

### D19. The hunk extension is self-contained; a contract test guards the sync
2026-09-13 · in effect

The hunk loader executes the extension file in its own process; our modules are
unavailable to it, so the handoff and mirror schemas are duplicated structurally.
The canon is `src/hunk/handoff.ts` and `src/hunk/notes.ts`.

**What holds it.** `test/hunk-ext.test.ts` runs the real extension against the
real writer and reader. Verified by mutations: renaming `patchText`,
`oldText`, `notesPath`, `hunkBin`, `root`, the `file` field, or the `side` field
breaks the test.

**Mirror schema** (found by a live run): path and coordinates — from
`note_created`/`note_edited`, set membership and deletions — from `note_changed`,
joined by `id`; in `note_changed` the path arrives as an opaque `fileKey` and
doesn't join with `changeset_loaded` directly.

### D20. The hunk version is pinned; the viewer is invoked via the platform binary
2026-09-13 · in effect

`hunkdiff@0.22.0` as an exact version: the Extension API is experimental and "may
change in breaking ways". We launch not the npm shim `bin/hunk.cjs` (it's
`#!/usr/bin/env node`, which won't find node itself in the stripped-down
`kitty @ launch` environment) but the platform binary
`hunkdiff-darwin-arm64/bin/hunk` — it doesn't need Node at all.
npm doesn't set its exec bit (both packages declare a `hunk` bin, a collision), so
the resolver fixes that with `chmod`. The `--no-update-check` flag does not exist in 0.22.0.

### D21. Post-MVP is dropped: no Herdr delivery, watch mode, or resolved cycle
2026-09-14 · in effect · revokes the T8 plan

**Why.** Delivering the batch into the agent's pane and watch mode justify each
other in a circle: push delivery is needed for the sake of watch, watch only makes
sense with push delivery, and separately neither adds anything from the spec
requirements to today's `!ntb` — the "Goal" scenario is covered by the stdout
batch and verified live in all three flows. On top of that, T8 depended on Herdr's
socket API, which was never spiked (the MVP uses only the `herdr pane` CLI), and on
Herdr's licensing ambiguity (sources say AGPL dual vs Apache-2.0).

**What is kept for a possible return.** The `Delivery` interface is designed for a
second implementation; the `id`/`status`/`resolvedBy` fields in the schema are
there for dedup and the resolved cycle; the herdr launcher already knows how to
find and reuse the pane.

### D22. Known defects are not fixed until they hurt
2026-09-14 · in effect

The final code review (two independent passes, 28 findings) fixed five groups on
the spot: review root, session cleanliness, comment mirror, Ctrl-C/hangs,
invariant guards. The remainder is left alone deliberately — none of it is
reachable in normal use — and lives in [`plans/known-gaps.md`](plans/known-gaps.md).

**Why the list is not here.** It is a backlog: it changes with the code, and
items go stale (two already had by the time of the rename). Keeping it in the log
would mean either rewriting entries — which the append-only rule forbids once
published — or carrying claims that are no longer true.

### D23. Spike docs are a record of an experiment, not a manual
2026-09-14 · in effect

Stale claims in the spike docs (`docs/`) and the probes (`scripts/`) get an
in-place amendment; the experiment text itself is never rewritten, otherwise the
protocol stops being a protocol. A probe with nothing left to run it is deleted
rather than repaired into a tool.

### D24. The reviewer subagent must not get write access to the working tree
2026-09-14 · in effect

**Why.** During the final review, the second-pass subagent didn't stop after its
report and started editing the same files as the main session. The collision was
caught only by `tsc` (a duplicate function declaration). Two sessions writing the
same files are guaranteed to clobber each other.

### D25. Distribution: a curl installer
2026-09-14 · in effect · supersedes the P0 sketch in `plans/roadmap.md`

`install.sh` fetched with `curl` is the only channel; `ntb --update` and a
re-run of the installer are the same code path. Releases are git tags.

**Why not npm** (this reverses the roadmap's P0 assumption). Node refuses to strip
types from any `.ts` file under a `node_modules` directory —
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, reproduced on Node 22.23 and 24.21
and against a real global install built from `npm pack`. Every npm layout puts the
package under `node_modules` (`lib/node_modules/` for `-g`, `_npx/<hash>/` for
npx), so npm and the no-build invariant (§6) cannot both hold. The roadmap asked
for exactly that combination; it is not available. Everything else about npm
worked: the nested dependency layout resolves the platform hunk binary, and the
`bin` symlink resolves through the sh wrapper.

**Why a curl installer over the alternatives.** It is the only channel where the
whole cycle is ours and the source lands outside `node_modules`. A Homebrew tap
would also satisfy that (a formula installs into `libexec/`) but adds a tap to
maintain for an audience that is entirely Claude Code users. A Claude Code plugin
is the strongest second option and was verified live: a plugin's `bin/` really is
added to the Bash tool's `PATH`, and dependencies really are installed from a
committed lockfile — but that install is capped at 60 s (we need ~114 MB), runs
with `--ignore-scripts`, and every version gets its own directory, so each
update re-downloads the viewer. It stays a cheap second channel later: a plugin is
this same repository plus a manifest.

**The marker is the safety property.** `<root>/.managed-install` is what separates
an install from a developer's checkout; without it both the installer and
`--update` refuse to act. This is the same class of hazard as the test that once
ate a live review: a `git checkout` in the wrong directory destroys work silently.

**Deferred.** The passive "a newer version is available" hint on ordinary runs.
It needs a live probe of how an extra stderr line behaves under `!` (repo rule),
and there is no published remote to check against yet. `ntb --update --check` is
the explicit form and covers the need for now.

### D26. The CLI surface is commands, not mode flags
2026-09-14 · in effect

`ntb <command> [flags]`: `review` (the default, so bare `ntb` is unchanged),
`open`, `collect`, `update`, `dump <what>`, `help`. Flags that used to select a
mode — `--open`, `--collect`, `--dump`, `--update` — are gone; `--check` now
belongs to `update`. Modifiers stay flags: `--turn`, `--launcher`, `--timeout`,
`--context`, and the global `--verbose` / `--help` / `--version`.

**Why.** The modes were already modelled as commands internally — `run.ts`
declares `RunMode = "auto" | "open" | "collect"` and `cli.ts` did nothing but
rebuild that enum from booleans. Spelling mutually exclusive modes as flags cost
four hand-written "these cannot be combined" checks, and left flags that the
chosen mode simply ignored: `ntb --collect --launcher kitty --timeout 5` parsed
happily even though collection builds no launcher and waits for nothing. With one
option table per command both problems are structural: the check disappears, and
a foreign flag is a parse error with no code of ours involved.

**Why `review` exists as a name even though bare `ntb` is the default.** Arbitrary
diff ranges are a wanted feature (`plans/roadmap.md`, P1), and `ntb main feature`
would be indistinguishable from a command called `main`. Naming the default means
ranges can live under it later — `ntb review main feature` — with no ambiguity and
no reserved-word rules, while `!ntb` stays the headline path. An unrecognised
first word is refused rather than guessed at, which is what keeps that door open.

**Not an agent-facing change.** The batch header (§3.1) carries no command names,
so the stdout contract is untouched; only stderr hints and docs changed. Rewording
the header itself would be the opposite case — a behaviour change.

### D27. Releases: no pre-release tags, no retagging, release-please cuts the tag
2026-09-15 · in effect · extends D25

The release list stays "git tags" (D25), narrowed to `vX.Y.Z` and to tags created
by release-please from the `package.json` version it just bumped. There are no
`-rc`/`-beta` tags and a published tag is never moved or deleted. The shape of the
scheme is in ARCHITECTURE.md §7.1; this entry records why the boundaries are where
they are.

**Why no pre-release tags.** Both the installer and `ntb update` pick a release
with `git tag --list --sort=-v:refname | head -n 1`. Probed on git 2.50.1 in a
throwaway repository: that order returns `v1.0.0-rc.1` *above* `v1.0.0`, so a
single rc tag silently becomes what every user installs and updates to. The fixes
available were `versionsort.suffix` in both call sites or no pre-releases at all;
for an audience of Claude Code users a release candidate buys nothing worth that
configuration. The `v[0-9]*` glob added to both call sites is a separate guard and
does not help here — `v1.0.0-rc.1` matches it.

**Why a tag is never withdrawn.** Probed the same way: after a tag is deleted on
the remote, `git fetch --quiet --tags --prune origin` leaves it in place on the
client — pruning tags needs `--prune-tags`, which neither `install.sh` nor
`src/update.ts` passes. A withdrawn release would therefore survive in every
existing install and keep being "newest" there. Retagging is not a recovery path;
the next patch release is.

**Why release-please over the alternatives.** It runs as a GitHub Action, so the
zero-dependency invariant (§6) holds — `semantic-release` and `changesets` are npm
packages and would put release tooling in `devDependencies`. It also makes the
`package.json`-must-equal-the-tag rule structural rather than a CI check: the same
run writes the version and creates the tag. `semantic-release` tags straight from
CI with no reviewable step, which is the wrong shape when tags are immutable.

**Two traps in its configuration**, both found in the upstream sources rather than
the docs. `buildNewVersion()` resolves a first release as
`release-as` → `Release-As:` footer → `bump()` only when a previous release exists
→ otherwise `initialReleaseVersion()`, which returns `initial-version` or a
hardcoded `1.0.0`; `bump-minor-pre-major` is never reached. Hence
`initial-version: 0.2.0` in `release-please-config.json` and `0.0.0` in the
manifest (that value is explicitly excluded from counting as a release) — remove
either and the first release of a fresh clone is 1.0.0. And the `release-as`
*config key* is deprecated precisely because it is sticky: it pins every future
release to the same version, and the duplicate-tag conflict that follows is
downgraded to a warning, so it fails silently.

**Consequences.** Resources created with `GITHUB_TOKEN` do not trigger other
workflows, so `ci.yml` does not run on the release pull request. That is only
acceptable while `main` has no required checks (it has none today, and none are
configured as rulesets): the release pull request touches version and changelog
files only, and CI runs on `main` immediately after the merge. Protecting `main`
means giving the release job a PAT or a GitHub App token in the same change.

**Amendment, 2026-09-16.** The paragraph above is wrong on its facts: the release
pull request *is* checked. The first real one (#4) got the full matrix from run
`35031129736`, `event: pull_request` on
`release-please--branches--main--components--notabene` — the documented
"resources created with `GITHUB_TOKEN` do not trigger workflows" behaviour did not
hold for it. That is lucky rather than merely tidy: this run is what caught
`test/install.test.ts` asserting on a version it had inherited from the
repository's own `package.json`, which broke the moment release-please bumped it.
A PAT is therefore only about branch protection, not about getting checks to run.

What *did* need changing was a repository setting: with
`can_approve_pull_request_reviews: false` (the default) release-please created its
branch and its commit and then failed with "GitHub Actions is not permitted to
create or approve pull requests". It is now enabled; `default_workflow_permissions`
stays `read`, so every workflow still declares the scopes it needs. Requiring
approvals on `main` later means revisiting this, since the same setting is what
lets a workflow approve pull requests.

**Amendment 2, 2026-09-16.** The first release came out tagged `notabene-v0.2.0`,
not `v0.2.0`: in manifest mode `include-component-in-tag` defaults to **true**, and
the component is the package name. `include-v-in-tag`, which we did check, only
governs the letter `v`. The consequence was silent in the worst way — the release
succeeded, the changelog was right, and `install.sh` simply did not see the tag,
because it selects releases with `v[0-9]*`; installs would have gone on tracking
`main` as though nothing had been released. The config now sets
`include-component-in-tag: false`, the bad tag and its GitHub release were deleted,
and `v0.2.0` was recreated on the same content. That deletion is the one case the
"tags are never withdrawn" rule does not cover: no install could have been made
from a tag the installer cannot match in the first place.

### D28. Complete and Cancel are commands of ours; delivery stays the default outcome
2026-09-15 · in effect

The viewer gets two finishing commands: `C` completes the review (flush, quit —
the comments go to Claude) and `x`/`X` cancels it, asking for confirmation when
comments exist and writing `notes-<stamp>.outcome.json` (§3.3), which the CLI
reads before delivering anything. Quitting any other way — `q`, a closed window,
a kill — still delivers, exactly as before the commands existed.

**Why `q` is not the cancel key**, which is where this started. An extension
cannot take a chord that a built-in already owns: in hunkdiff 0.22.0
`buildExtensionAppCommands` probes every declared chord against the built-ins and
against chords already claimed by other extension commands, and on a hit it pushes
the chord to `conflicts` and *skips the binding* — the command is still
registered, just with no key, and the host reports the conflict. `hunk.app.quit`
owns `q` (`defaultKeys: ["q"]`, `locus: "host-only"`). So "`q` means cancel" could
only be built by inverting the CLI: deliver *only* on an explicit Complete. That
was rejected — it turns the habitual exit into silent destruction of a review's
worth of work, and the one place a confirmation would help is the one place we
cannot put it, since `q` never reaches us.

**What made the commands possible at all.** `hunk.app.quit` is
`publicToExtensions: true`, so `ctx.commands.execute("hunk.app.quit")` closes the
viewer from a command handler; a `false` return is treated as "the host refused"
and the user is told to press `q`. `c` was unavailable for Complete
(`hunk.review.startNote`), hence the capital `C`; `x` was free.

**Where the keys are advertised.** In the review title, which hunk paints into the
menu bar — because nothing else is both ours and always on screen. The `?` help is
built by `buildHelpSections` from a hardcoded `HELP_SECTIONS` list of built-in
command ids, so an extension command can never appear there; the menu *does* pick
ours up automatically (`toExtensionMenuEntries` files them under `Extensions`,
`MENU_LABELS`), but only once the user opens it. The title is rendered muted on the
right of the menu bar (`showMenuBar: true` by default), hunk appends its own file
and line counts after it, and the whole string is clipped by `fitText` — so the
hint is kept to `[C] complete  [x] cancel`, bracketed so that it reads as keys
rather than as part of the changeset's name. It is static text: a rebinding through
hunk's `[keybindings]` config would make it lie, which is the price of the only
visible slot available.

**Consequences.** The marker is per-review and named after its mirror, so
reopening the same review (flow C) must clear it — otherwise a cancellation
would outlive the opening it belonged to. A cancelled review leaves no
machine-readable copy: nothing was reviewed, so there is no history to keep.
A docked pane (`registerPane`) would give real, clickable buttons and was left
alone deliberately: its component is typed `(props) => unknown` — a React/OpenTUI
node — so it would mean rendering through hunk internals that no published type
covers, plus a `react` import that is only in our tree as hunkdiff's transitive
dependency (§6 allows one runtime dependency, and this would be a second, implicit
one). `onActivate` reports a click somewhere in the pane, not on a button.

### D29. The review is launched by the agent (`/ntb`), because only then does a finished review wake it
2026-09-16 · in effect · amends D12

The entry point is the plugin skill `/ntb` (§7.2): the agent runs `ntb` through
the Bash tool, blocking, with the harness's maximum timeout (600 s on Claude
Code) and never `run_in_background`. `!ntb` keeps working unchanged and is
demoted to the second way in. The viewer wait goes from 30 minutes to 4 hours.

**Why.** A review usually outlives the detach ceiling, and what happens next
depends on who owns the process — which D12 never asked. Measured live
2026-09-16, four runs:

- a Bash-tool background task that finished while the agent was idle
  **re-invoked it** with no human message; reproduced on two real reviews;
- the notification carries only a summary, the exit code and the task file path —
  never the batch text, the same shape D12 recorded for the `!` detach. The file
  is verbatim, stderr included;
- a review finished inside the 600 s ceiling returned the batch **inline** in the
  tool result: no file, no notification, no wake-up involved;
- a `!`-command has no agent turn to return to, so its completion re-invokes
  nobody. This is why a finished review used to sit until the user wrote again —
  the defect this entry exists to fix.

Not witnessed: a detach and a non-empty batch in the same run. Both halves are
shown separately and D12 showed a non-empty batch surviving the detach into a
task file, so the composition is inferred rather than observed.

**Why not `run_in_background`.** It was the first proposal and it is wrong — on
borrowed evidence, not ours: we never ran the viewer detached. A shipped
Claude Code diff-review plugin forbids it outright for interactive TUI launchers,
reporting that processes get killed unprompted and that the polling loop it
invites leaves the session idle exactly when the review finishes. Blocking with
the harness maximum is what that tool and this one arrived at independently.
Where we go further is past the ceiling: there it asks the user to send a
message, which is the defect this entry removes.

**Why 4 hours.** At 30 minutes a live run expired mid-review: expiry exits with
empty stdout, which drops delivery back to a manual `collect` and therefore back
to needing a human message — reintroducing the whole defect. The old value was
calibrated for `!ntb`, where the process held the user's command hostage; run
from the Bash tool it holds nothing and the agent is asleep, so waiting is free.

**Consequences.** `/ntb` needs two installs — the CLI from `install.sh` and the
plugin — and collapsing them is not done (§7.2). They also update by separate
paths with nothing checking that they stay in step, which is a new coupling this
entry creates and deliberately leaves open. A skill's `allowed-tools` does
**not** bypass the automatic permission-mode classifier: `ntb` was refused twice,
including through the skill, so the first run needs an ordinary approval or an
explicit `Bash(ntb:*)` rule. A forgotten viewer now refuses new reviews for four
hours rather than thirty minutes; `collect` still ends it at any point. `ntb`
itself learns nothing about its caller: no flag, no branch, and the batch header
(§3.1) is untouched, so this is not a contract change.
