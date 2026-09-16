---
name: review
description: Review the diff in the notabene hunk viewer and act on the comments that come back. Opens the changeset in a Herdr pane, a kitty tab, or by hand, blocks while the human comments, and treats the resulting batch as the instruction. Activates on "ntb", "notabene", "review the diff", "review my changes", "review this branch", "review what's staged", "open the review", "collect the review".
argument-hint: '[REV | REV REV] [--staged] [--context] [--launcher NAME]'
allowed-tools: [Bash(ntb:*), Read, Edit, Write, Grep, Glob]
---

# notabene — diff review that answers back

Run the review and act on what comes back. `ntb` is on `PATH` after
`install.sh`; if it is missing, say so instead of guessing at a path.

## 1. Launch

Run `ntb $ARGUMENTS` with the Bash tool: blocking, and with the bash timeout
parameter set to **the maximum the harness allows** (600000 on Claude Code).

Do **not** pass `run_in_background` — background handling is unreliable for
interactive TUI launchers. Do not poll, and do not start other work while it
runs: the human is reading the diff, and there is nothing to do until they quit
the viewer.

With no arguments the review opens on the working tree, and the human can switch
scope inside the viewer — so pass an argument only when they asked for a specific
comparison: `--staged` for the index, one revision (`ntb main`) for everything
since the branch left it, two (`ntb HEAD~3 HEAD`) for a plain range.

Two launches that end early, both on stderr:

- *"there is already an unfinished review"* — run `ntb collect`, act on whatever
  batch it prints, then start over from step 1.
- *"run `ntb collect` when you're done"* — no supported terminal was detected, so
  the viewer has to be opened by hand (flow C). Relay that and stop; the batch
  will arrive through `collect`.

## 2. The batch

`ntb` writes exactly one thing to stdout — the review batch. Everything else is
stderr diagnostics; progress lines about the viewer are not review findings.

- **stdout non-empty** — the batch's own header is your instruction, follow it.
  `@path:start-end` references are relative to the git repository root, which is
  not necessarily the session's working directory.
- **stdout empty** — the human left no comments, or cancelled the review in the
  viewer. Say so in one line and stop. Do not guess what they might have meant,
  and do not re-run the review to check.

## 3. If it is moved to the background

A review that outlasts the timeout gets detached: you get "moved to the
background" with a task id and an output file path.

This is not a failure and not the end of the review. End your turn with a single
line saying you are waiting for it. Do not poll the file, do not ask the human
whether they are finished, do not start other work.

When the task-completion notification arrives it carries only a summary and that
path — the batch text is not in it. Read the file: the batch is there verbatim,
followed by `[exited with code 0]`. Then act on it exactly as in step 2.

## 4. If the viewer wait timed out

`ntb` stops waiting after its own `--timeout` (4 hours by default) and exits
with empty stdout, saying the viewer was left open. The comments are **not**
lost: they are in the mirror on disk.

Run `ntb collect` to deliver them. Do this when the human tells you they are
done — collecting mid-review takes only the comments written so far and closes
the session on the rest.
