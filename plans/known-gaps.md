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

## Performance

- `fillSideTexts` fetches file versions sequentially: 200 files take ~2.4 s.

## Robustness

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
