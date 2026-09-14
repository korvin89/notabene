# Roadmap candidates (post-MVP)

The development plan is closed (DECISIONS.md D21, D22): nothing here is committed
work. This is a prioritized backlog of candidate directions, informed by a survey
of mature general-purpose diff-review TUIs for AI coding agents (2026-09). Items
are picked up on demand; each entry sketches the cost on the current
architecture (seams from ARCHITECTURE.md §2).

## Positioning

What comparable tools cover that we deliberately do not — and the other way
around. This frames which gaps are worth closing and which are not.

Our niche, not offered by general-purpose tools:

- **Per-turn review.** General-purpose tools review VCS refs only; they have no
  notion of an agent turn or conversation checkpoint. We reconstruct turns from
  the Claude Code file-history and label them with prompt snippets — this is the
  headline feature and the reason the project exists.
- **Graceful degradation.** Typical plugin launchers hard-fail when no supported
  terminal/multiplexer is detected. Our manual two-step flow (flow C) works in
  any terminal, always.
- **The async model.** Overlay-style integrations block the agent's tool call
  and don't document what happens at the shell-command timeout ceiling. We
  explicitly handle the 120 s detach ("moved to the background"), keep a 30-min
  viewer timeout, and recover via `collect`.
- **Session hygiene.** One review per repository with refusal instead of silent
  overwrite, parallel-session discrimination via the pid chain, uniquely named
  comment mirrors against a forgotten viewer.
- **Typed, structured output.** First-class comment types
  (question/change/blocker) and a versioned JSON copy with `status`/`resolvedBy`
  reserved for a future resolved cycle — versus plain-markdown annotations with
  ad-hoc markers.

Where the mature tools are ahead (beyond the concrete gaps below): their own
rich TUI with no external viewer dependency, package-manager distribution
(brew/apt/rpm), multi-VCS support, review history with crash recovery.

## Candidate features

### P0 — distribution and updates · done, 2026-09-14

1. ~~**An install and update story.**~~ Shipped as `install.sh` + `ntb update`
   (ARCHITECTURE.md §7, DECISIONS.md D25). The npm channel this item assumed
   turned out to be unavailable: Node refuses to strip types under
   `node_modules`, so npm and the zero-build invariant cannot both hold.
   What remains open from the original item:
   - **Update awareness.** A passive "newer version available" hint on ordinary
     runs is deferred: it needs a live probe of how an extra stderr line behaves
     under `!`. `ntb update --check` is the explicit form today.
   - **Release process.** Tags exist as the mechanism; a changelog and a
     published remote are still to come.
   - **A second channel** — a Claude Code plugin — stays cheap on top of this
     repository (D25 has the measurements); Linux support (item 11) is its
     natural companion.

### P1 — best value for cost

2. **Arbitrary diff ranges.** Today the `current` source is hardcoded to
   "working tree vs HEAD + untracked". Add base/against arguments
   (`ntb main feature`, `HEAD~1 HEAD`) and `--staged`. Cost: low — a
   parameter on `DiffSourceOptions`, the unified-patch parser in
   `diff/current.ts` already does the heavy lifting; the changeset model is
   untouched.

3. **tmux launcher (then Zellij).** The launcher chain (`Launcher` interface,
   detect-by-env) was built for this: one adapter ≈150 lines by analogy with
   `kitty.ts` (`tmux display-popup` blocks until quit, which fits flow A/B
   semantics). Zellij is the same shape. Widens flow-A/B coverage beyond
   herdr + kitty without touching the core.

### P2 — opens new ground, moderate cost

4. **Host-agent seam (`AgentHost`) + a second agent in Current mode.** The
   findings from the architecture review (2026-09-14): bundle session
   resolution, the state dir (`claudeDir` → neutral name), the optional turns
   source, the instruction strings, and the detach constant behind one
   interface; select the host by detection like launchers. Other agents have no
   file-history equivalent, so a second host starts Current-only — which the
   degradation design already treats as a first-class mode, not a cut-down one.
   Prerequisite: verify live that the target agent has an equivalent of the
   "user-run shell command whose stdout enters the context" affordance.

5. **Plan review.** Review the agent's proposed plan (markdown) before any code
   exists, with the same annotate → revise loop. Feasible via a synthetic
   changeset "empty → plan text": the handoff already carries full side texts
   for `readFileSource`. Needs a delivery header variant ("Review of the plan…")
   and an input path (flag reading a file/stdin).

6. **Non-VCS review modes.** Piped text (scratch buffer), two-file compare, a
   single file outside a diff. Same synthetic-changeset mechanism as plan
   review; mostly CLI surface.

### P3 — nice to have

7. **File-level comments.** The model anchors to lines only. Needs a mirror
   convention for "no line anchor" and a batch item format without `:start-end`;
   viewer support is the open question (hunk has no file-level notes — probe
   live first, per the repo rule).
8. **Annotation round-trip.** Preload a previous review's comments into a new
   session (the JSON copies already contain everything needed).
9. **Path filtering** (`--include`/`--exclude` prefixes) on changeset assembly.
10. **`--output` to a file** in addition to stdout (delivery already has the
    interface seam; D21 kept it for a second implementation).
11. **Linux support.** De-hardcode the macOS paths (kitty app path, platform
    hunk binary resolution in `hunk/bin.ts`). A companion to the P0
    distribution work.

## Non-goals

- **Viewer UI features**: themes, keybinding remaps, vim motions, mouse,
  search, blame, word-level diff, "file viewed" marks. We delegate the UI to
  the hunk viewer by decision (stack variant A); these come from hunk upstream
  or not at all. Matching a full in-house TUI feature-for-feature would mean
  becoming one — out of scope.
- **Exit-code signaling of "annotations present".** Our contract is the
  opposite by design: empty stdout ⇒ the agent stays silent, exit 0 either way
  (ARCHITECTURE.md §3.1, §3.4).
- **Push delivery / watch mode** — already considered and dropped (D21).
