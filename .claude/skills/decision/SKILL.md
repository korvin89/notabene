---
name: decision
description: Add an entry to DECISIONS.md — or decide that the change does not deserve one. Use when a decision was made, a behaviour changed, an alternative was rejected, or a live probe contradicted the documentation. Also use when unsure whether something belongs in the decision log.
---

# Adding to the decision log

The log is small on purpose. Most changes do not belong in it, and the default
answer to "should this be an entry?" is **no**.

## The one test

**An entry earns its place only if a future reader would decide differently
because of it.**

Apply it out loud before writing anything. If the honest answer is "they would
just know what happened", that is a changelog, and git already has one.

### Three kinds that pass

1. **A live-verified fact that contradicts documentation or intuition.** The most
   valuable kind — it costs hours to rediscover. It must carry the evidence:
   what was run, on what version, what came out. Examples in the log: `/dev/tty`
   under `!` returns ENXIO (D3); kitty's `--wait-for-child-to-exit` hangs the
   client despite working in the probe (D5); Node refuses to strip types under
   `node_modules` (D25).
2. **An alternative rejected, with the measurement that killed it.** This is what
   stops the same idea being re-proposed in six months. Name the alternative, the
   specific thing that ruled it out, and what *did* work about it — a rejection
   with no upside recorded reads as prejudice and gets re-litigated.
3. **An invariant whose reason is not visible in the code.** If someone could
   "clean this up" and break it, the reason belongs here. Example: the Herdr pane
   is deliberately not closed (D18).

### What does not pass

- **Renames, moves, reorganisations, translations.** The current state already
  says it. Fix the affected docs instead.
- **Backlogs and known defects** → `plans/known-gaps.md`. They change with the
  code; in an append-only log they rot into false claims.
- **Project history** — what order work was done in, which ticket something came
  from, what got cut from a milestone.
- **Anything already stated in ARCHITECTURE.md.** If it describes how the system
  works, it is design, not a decision. Put it there and link if needed.

A useful filter: if the entry's body could be reconstructed by reading the repo
as it stands today, drop it.

## Writing the entry

Append at the end. Number sequentially from the last `### D<n>`.

```markdown
### D<n>. <the decision, as a claim in one line>
<YYYY-MM-DD> · in effect[ · revokes D<m> | · supersedes <what>]

<What was decided, in two or three lines. Concrete, present tense.>

**Why.** <The evidence. Versions, measurements, what was run and what came out.
Not "it seemed better" — what made it better.>

**Consequences.** <Only if something non-obvious follows: a new constraint, a
cost accepted, a door closed or kept open.>
```

Rules that are not negotiable:

- **English**, like the rest of the project — including amendments to old entries.
- **Never rewrite an entry retroactively** once the repository has been pushed.
  Revisiting a decision means a new entry that marks the old one revoked. Before
  the first push there is no published history, so consolidation is still allowed —
  check `git remote -v` if unsure.
- **Design changes update ARCHITECTURE.md in the same commit.** The log says why;
  ARCHITECTURE says what the system is. Do not let them disagree.
- If the entry describes a change to the stdout batch wording, say so explicitly:
  that text is an agent-facing contract (ARCHITECTURE.md §3.1), and changing it
  changes behaviour.

## Procedure

1. State the candidate decision in one sentence.
2. Run the test above. If it fails, say which non-passing category it fell into
   and where the information should go instead — then stop.
3. Check whether an existing entry already covers it; extending or revoking one
   beats adding a near-duplicate.
4. Find the last entry number (`grep -n '^### D' DECISIONS.md | tail -1`).
5. Write the entry. Keep the evidence, cut the narrative.
6. Update ARCHITECTURE.md / README.md in the same change if the design or the
   user-facing behaviour moved.
7. `npm test` and `npm run typecheck` before committing.
