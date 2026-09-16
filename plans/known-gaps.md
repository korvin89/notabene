# Known gaps

Defects and rough edges we know about and deliberately have not fixed (DECISIONS.md
D22). This is a backlog, not a decision log: it changes as the code does, items get
crossed off or turn out to be wrong. Nothing here blocks anything.

Origin: the final code review of the MVP (two independent passes, 28 findings,
2026-09-14). Five groups were fixed at the time — review root, session cleanliness,
comment mirror, Ctrl-C/hangs, invariant guards. What follows is the remainder,
re-checked on 2026-09-14 after the rename and the distribution work.

## Behaviour

- A clean working tree with a non-empty turn list says "No changes" instead of
  hinting at `--turn N`.
- The context line for an anchor at the end of a file produces an empty `>` in the
  batch.
- `parseTurn("3abc")` returns 3 instead of refusing.
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

- `fillSideTexts` fetches file versions sequentially: 200 files take ~2.4 s.

## Robustness

- Nothing checks that the plugin and the CLI are in step. They update by separate
  paths (`/plugin update` against `ntb update`), and the skill keys off CLI
  behaviour — its flags and the stderr phrases it branches on — so a one-sided
  update makes the skill misinstruct the agent silently. There is no migration
  machinery to hang a fix on either: `ntb update` is `git checkout` plus `npm ci`,
  and artifact `version` fields are refusal gates, never upgrades. Deferred on
  purpose until it bites: the cheap fix is a version floor checked in the skill
  via `ntb --version`, not a migration — nothing durable is read back today
  (the final copies in the state directory are write-only).
- `applyStructuredPatch` does not check hunk order.
- Open questions never probed: how kitty polling tolerates a client failure,
  `a//abs/path` in the patch for files outside the review root, the `matched` field
  in the herdr `wait-output` response, EPIPE in `emit()`.

## Dead weight

- Unused fields `BackupRef.version`, `ReplayEdit.order`, `SessionRegistryEntry.kind`.
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
