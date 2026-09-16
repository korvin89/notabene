# Known gaps

Defects and rough edges we know about and deliberately have not fixed (DECISIONS.md
D22). This is a backlog, not a decision log: it changes as the code does, items get
crossed off or turn out to be wrong. Nothing here blocks anything.

Origin: the final code review of the MVP (two independent passes, 28 findings,
2026-09-14). Five groups were fixed at the time — review root, session cleanliness,
comment mirror, Ctrl-C/hangs, invariant guards. What follows is the remainder,
re-checked on 2026-09-14 after the rename and the distribution work.

## Behaviour

- The context line for an anchor at the end of a file produces an empty `>` in the
  batch.
- `note_changed` does not update a comment's body, so an edit made after the note
  was created can be missed.
- `hunk` in the machine-readable copy is always `null` — the extension does not
  mirror the hunk index.
- A viewer that outlives `collect` re-creates its comment mirror on quit, after
  cleanup already removed it: the state directory keeps a `notes-<stamp>.json` with
  no `pending.json` or `handoff.json` beside it. Observed 2026-09-16 — collected at
  ~14:55, the file reappeared at 15:01 when the viewer closed. Harmless rather than
  dangerous: mirror names are unique per review (D15), so nothing is clobbered and
  no later run is blocked; readers take the path from the handoff, which is gone, so
  the orphan is inert. It is litter that accumulates in the state directory — since
  D30 outside the repository, so it no longer reaches anyone's `git status`.

## Performance

- `fillSideTexts` fetches file versions sequentially: 200 files take ~2.4 s. Since
  D31 a run builds up to three scopes, so this is walked up to three times — the
  per-run text cache spares the repeated blobs but not the first pass over each.
- Nothing caps how big a scope may be. On a long-lived branch `since <base>` puts
  the full text of both sides of every file it touches into `handoff.json`, which
  the extension then reads whole. Left alone until a review is slow enough to
  notice (D22).

## Robustness

- Half-closed by D32: `ntb update` now reports when the plugin is missing or
  behind on a release that changed the skill. That covers the harmless direction
  — CLI ahead of the skill, where the agent merely fails to know about a new
  flag. **The harmful direction is still open**: a skill ahead of the CLI tells
  the agent to pass flags this `ntb` has never heard of, and it finds out as a
  usage error mid-review. `ntb update` cannot help there by construction — it
  runs when the CLI moves. The fix is a floor checked from the skill side
  (`ntb --version` against a number the skill carries), and whether
  release-please can keep that number current through `extra-files` is unverified.
- A mistyped command (`ntb reviw`) is now read as a revision and fails with
  "unknown revision" plus the list of commands. Honest, but a near-miss check
  would be kinder.
- Open questions never probed: how kitty polling tolerates a client failure,
  `a//abs/path` in the patch for files outside the review root, the `matched` field
  in the herdr `wait-output` response, EPIPE in `emit()`.

## Dead weight

- Unused field `SessionRegistryEntry.kind`.
- The `NotImplementedError` class and exit code 3 — unreachable, kept as scaffolding.

## Superseded since the review

- *"Resolving the platform hunk binary from a globally installed npm shim misses by
  one level."* Narrower than it looked: npm is not a distribution channel (D25), and
  a global install nests dependencies under the package directory, which resolves
  correctly. The shim fallback in `hunk/bin.ts` now only matters when a user has
  `hunk` installed globally and our own `node_modules` is absent.
- *"The node version is not checked in the `review` wrapper."* `install.sh` now
  refuses to install on Node < 22.18. The wrapper itself still only checks that
  `node` exists at all, which is the remaining half.
