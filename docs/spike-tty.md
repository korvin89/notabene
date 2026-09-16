> References of the form "DESIGN.md §N" below point to the original design document:
> on 2026-09-14 it was folded into [ARCHITECTURE.md](../ARCHITECTURE.md) and
> [DECISIONS.md](../DECISIONS.md). The experiment text is left as is.
>
> The probe scripts moved to `scripts/` on 2026-09-14. The command lines recorded
> below still say `docs/…` because that is what was run at the time; to re-run one
> today, read it as `scripts/…`.

# Probes of the `!` environment

> Translated from the Russian original on 2026-09-14; the protocol content is preserved as recorded (DECISIONS.md D23).

What is and is not possible inside a Claude Code `!` command. Probes 1–2 are the T1a gate
(terminal), probe 3 is T2 (the duration ceiling).

Date: 2026-09-13.

## What we checked and why it is a blocker

The viewer is launched as `!review`. From DESIGN.md §1.3 it is known that the stdout of a `!` command
is captured and goes into the context — meaning stdout is a pipe, and no TUI can be drawn there. The
only working model is the fzf one: the UI is written to `/dev/tty`, while stdout remains a clean
channel for the comment batch. Hence the question the whole architecture rests on: **is
`/dev/tty` available under `!` for reading, writing, and raw mode.**

## Probe 1 ([`probe-tty.sh`](../scripts/probe-tty.sh)) — **FAILURE**

```
! sh docs/probe-tty.sh
```

```
=== T1a probe: TTY handover under `!` ===
env:    CLAUDE_CODE_SESSION_ID=b0d37a65-8e57-47be-9084-ae66d398e354  CLAUDE_PID=56234
fds:    stdin_tty=no  stdout_tty=no  stderr_tty=no
tty(1): not a tty
devtty: readable=yes  writable=yes
docs/probe-tty.sh: line 22: /dev/tty: Device not configured
devtty: write FAILED
VERDICT: NO /dev/tty — fzf-модель НЕ работает, нужен аварийный план (DESIGN.md §6)
```

(The last line is the script's recorded Russian message: "the fzf model does NOT work, a fallback
plan is needed".)

### Breakdown

- **Confirmed** from DESIGN.md §1.1 and §1.3: `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` are visible
  under `!`; stdin, stdout, and stderr are all three pipes, none of them a terminal.
- **Refuted**: the assumption of §1.4 — `/dev/tty` is **unavailable**. `test -r`/`test -w` say `yes`
  because they check the permissions on the device file, not the ability to open it; a real
  `open()` fails with `Device not configured` — that is **ENXIO**, the canonical error code for
  "the process has no controlling terminal". In other words, Claude Code runs the `!` command in a
  session detached from the terminal (`setsid` or an equivalent), not merely with
  redirected streams.
- A small thing for the future: the script's entire output (plain `echo`, i.e. stdout) arrived in the
  context labeled as stderr. For §1.3 this does not matter — both streams are captured — but do
  not count on it when parsing output.

**Conclusion: the fzf model via `/dev/tty` under `!` is impossible.** This is exactly the risk the
gate was put up for: "`!` does not hand over the TTY" from DESIGN.md §6.

## Probe 2 (`probe-tty2.sh`) — a loophole, **partially verified**

> The script itself was deleted after the MVP was closed: the M4 loophole was never actually run and
> does not affect the chosen launch model (§8). Below is what we managed to learn.

`/dev/tty` is the process's *controlling* terminal. But the terminal device that `claude` sits on has
not gone anywhere: `ps -o tty= -p $CLAUDE_PID` → `ttys002` → `/dev/ttys002`. Opening it by its
direct path is allowed by the permissions. We check three stages: writing → raw mode and
reading a key with a timeout → the alternate screen.

```
! sh docs/probe-tty2.sh
```

### What is already known

The script inadvertently ran from the Bash tool environment (it also has `CLAUDE_PID`, so the
"headless" run turned out not to be headless and switched the user's terminal for 3 seconds):

```
ps tty= -> 'ttys002'
device: /dev/ttys002  readable=yes  writable=yes
stage1 write: OK
stage2 stty raw: OK
stage2 read: пусто (таймаут)
stage3 alt-screen: нарисован и закрыт
```

(Recorded Russian output: stage2 read — "empty (timeout)"; stage3 alt-screen — "drawn and closed".)

- **Output to the terminal works** — `/dev/ttys002` opens for writing from a process without a
  controlling terminal, `stty raw -echo` can be set on it, the alternate screen is drawn
  and closed. Restoring the settings via `trap` worked.
- **Input was not verified**: stage 2 returned empty because in that run no one pressed a key
  (a 5 s timeout via `VMIN=0 VTIME=50`). This is not a negative result, but an absent one.

### What a live run should show

The real question is not "can a byte be read" but **who gets the pressed key**: our
process and Claude Code itself are reading the same terminal simultaneously.

- the key `x` arrived in `stage2 read` → Claude Code does not read input during `!` → the fzf model
  can be rescued via the direct path to the device;
- `x` instead ended up in the Claude Code prompt (or got lost) → an interactive viewer from
  `!` is impossible in principle, and this is the final switch to the fallback plan.

## Probe 3 — the `!` command duration ceiling (T2) — **there is a ceiling: 120 s, but the command is not killed**

Flows A and B (DESIGN.md §8.5) keep `!review` blocked while the user looks at the diff.
If Claude Code has its own ceiling on the duration of a `!` command, then the whole single-command
scenario runs into it, not into our timeout. All that was known is that 50 seconds pass
(stage 3 of the kitty probe) — which proves nothing.

```
! sh -c 'sleep 600; echo alive-600s'
```

### Result

```
Command did not complete within its 120s timeout and was moved to the background (ID: bbo0n8uvu).
Output is being written to: …/tasks/bbo0n8uvu.output. You will be notified when it completes.
```

The ceiling is **120 seconds**, and it is exactly the default Bash tool timeout (`BASH_DEFAULT_TIMEOUT_MS`,
120,000 ms; the user's `~/.claude/settings.json` has no `env` section, so the
default kicked in). But the key thing is something else:

- **the process is not killed.** 3.5 minutes after the start, `ps` shows both
  `sh -c 'sleep 600; …'` and the `sleep 600` itself alive — Claude Code simply stops waiting and
  detaches the command, redirecting its output to the task file;
- when the background command completes, a notification arrives with its output.

### What this means for the launch model

Flows A and B **do not break**, but they stop being synchronous on a long review:

```
0–120 s     !review blocks the session, as intended
120 s       Claude Code detaches the command: "moved to the background"
            our process is alive, the viewer is open, the user comments in peace
exit        review prints the batch to stdout and terminates
            → the batch reaches Claude via the background-task completion notification
```

So the "one command" UX is preserved; only the moment the batch arrives changes. Cutting our
own wait timeout below 120 s would be **harmful**: it would cut short a review that
lives longer than two minutes, whereas on its own it continues just fine. Therefore
`DEFAULT_TIMEOUT_MS` stays at 30 minutes, and the 120 s are pinned as a separate constant
`BANG_DETACH_MS` — it is needed not for interruption, but to warn the user in stderr
that "moved to the background" is normal, not a failure.

Remaining to check in T5/T7 (on a live review, not on a `sleep`):

1. does the stdout of a background task reach Claude's context whole and verbatim — this
   decides whether flow C is needed for long reviews;
2. does `BASH_DEFAULT_TIMEOUT_MS` in `~/.claude/settings.json` raise the ceiling (and whether raising
   it is appropriate: 120 s is a reasonable guard against hung commands, and changing it globally
   for the sake of our scenario is dubious).

### Addendum: the probe lived to the end, item 1 half closed

The background task ran the full 600 s and finished with code 0 — the detach at second 120
really does the process no harm at all. On delivery (item 1) the picture is:

- the completion notification **does not contain stdout verbatim** — only a
  summary (command, exit code) and the **path to the file** with the output arrive in the context;
- the file itself is intact and verbatim (`alive-600s` is in place), Claude reads it with the regular Read.

So on a long review the batch will arrive not "by itself" but through reading a file — workable, but
the batch header should account for this (the instruction for Claude must not rely on the
text already being in the context). What remains to check on a live review in T5/T7: does Claude read
the task file upon the notification without a reminder, and in full (read limits on large batches).

### Closure in T7: a live long review, item 1 fully closed

T7 run #2 (2026-09-14): `! ./review`, the viewer kept open ~2.5 minutes, one
comment, `q`. Exactly the predicted was observed: at second 120 — "moved to the
background" with the path to the task file; after exiting the viewer — the completion notification
(summary + code 0 + path, **without the batch text**); Claude, upon the notification, read the file
**by himself** with the regular Read and got the batch **whole and verbatim** — the header, the item,
the path to the JSON copy, and the trailing `[exited with code 0]`. The file also captures stderr
(the recorded line "Жду вьюер…" ["Waiting for the viewer…"]) — this does not confuse Claude.

**The batch header needs no changes**: the "reply to each item" instruction fires after
reading the file exactly as with synchronous delivery. The residual risk — Claude in someone else's
session may not read the file upon the notification — is accepted as an MVP limitation (README);
the safety net is to ask him to read the file, or to use `--collect`.

On item 2 (whether to raise `BASH_DEFAULT_TIMEOUT_MS` globally): **we do not.** Asynchronous
delivery works, and a global timeout tweak for the sake of one scenario affects all
`!` commands and the agent's Bash tool. Whoever needs strict synchrony — the option in settings.json
is mentioned in the README as voluntary.

### Amendment 2026-09-16: the probe measured delivery, not wake-up

Probe 3 and both closures above ask one question — *does the text arrive whole?* — and
answer it correctly. They never ask the second one: **does the notification wake an agent
that has already finished its turn?** For a `!`-command it does not. The command belongs to
the user, there is no agent turn to re-invoke, and the batch sits in the task file until the
user writes to the agent. Both live closures hid this, because in each the human typed a
message afterwards.

So the sentence above — "Claude, upon the notification, read the file **by himself**" — holds
only for a session that was going to run anyway. Measured on 2026-09-16: the same detach under
a **Bash-tool** call does re-invoke the idle agent, with no human message, which is what moved
the entry point to `/ntb` (D29). The conclusion about the batch header still stands: it needed
no change then and needs none now.

## Verdict

**Launching the viewer from `!` via `/dev/tty`, as laid down in the spec, does not work.** One
unverified chance remains (the direct path to the terminal device) and, regardless of its outcome, the
delivery model from DESIGN.md §3 needs revisiting. The fallback plan options are in DESIGN.md §8.

Important: this result **does not affect** the choice of viewer (§7, hunk vs tuicr) — it changes the way
of launching and collecting, not the changeset source. Moreover, "the viewer lives in a separate
terminal, the agent talks to it via the CLI" is exactly the model both hunk
(`hunk session *` + the bundled skill literally says "ask the user to open Hunk in another
terminal") and `herdr-hunk-diff` from the spec are designed around.
