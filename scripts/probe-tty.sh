#!/bin/sh
# References of the form "DESIGN.md §N" below point to the original design document;
# on 2026-09-14 it was folded into ARCHITECTURE.md and DECISIONS.md. The probe text
# is left as is.
# T1a — TTY-handover probe under `!` (DESIGN.md §1.4, §6 "risk: ! does not hand over the TTY").
# Run ONLY from the interactive Claude Code prompt:  ! sh scripts/probe-tty.sh
#
# What we check:
#   1) the session env is visible under `!`
#   2) stdin/stdout/stderr — pipe or tty
#   3) /dev/tty opens for reading and writing
#   4) raw mode can be enabled on /dev/tty (stty)
#   5) the alternate screen draws on /dev/tty and restores cleanly
#   6) a key can be read from /dev/tty in raw mode (the fzf model)
#
# Everything diagnostic is printed to stdout (it will go into Claude's context),
# all UI goes strictly to /dev/tty.

echo "=== T1a probe: TTY handover under \`!\` ==="
echo "env:    CLAUDE_CODE_SESSION_ID=${CLAUDE_CODE_SESSION_ID:-none}  CLAUDE_PID=${CLAUDE_PID:-none}"
echo "fds:    stdin_tty=$(test -t 0 && echo yes || echo no)  stdout_tty=$(test -t 1 && echo yes || echo no)  stderr_tty=$(test -t 2 && echo yes || echo no)"
echo "tty(1): $(tty 2>&1)"
echo "devtty: readable=$(test -r /dev/tty && echo yes || echo no)  writable=$(test -w /dev/tty && echo yes || echo no)"

if ! printf '' > /dev/tty 2>/dev/null; then
  echo "devtty: write FAILED"
  echo "VERDICT: NO /dev/tty — the fzf model does NOT work, a fallback plan is needed (DESIGN.md §6)"
  exit 1
fi

SAVED=$(stty -f /dev/tty -g 2>/dev/null)
if [ -z "$SAVED" ]; then
  echo "stty:   cannot read settings from /dev/tty"
  echo "VERDICT: NO raw mode — the fzf model does NOT work (DESIGN.md §6)"
  exit 1
fi
echo "stty:   settings readable (len=${#SAVED})"

restore() {
  printf '\033[?1049l' > /dev/tty 2>/dev/null
  stty -f /dev/tty "$SAVED" 2>/dev/null
}
trap 'restore' EXIT INT TERM

if ! stty -f /dev/tty raw -echo 2>/dev/null; then
  echo "stty:   raw mode FAILED"
  echo "VERDICT: NO raw mode — the fzf model does NOT work (DESIGN.md §6)"
  exit 1
fi
echo "stty:   raw -echo OK"

# alternate screen + cursor at 1,1
printf '\033[?1049h\033[H' > /dev/tty
printf 'T1a: the alternate screen works.\r\n' > /dev/tty
printf 'If the session background/content is hidden right now — that is what we want.\r\n\r\n' > /dev/tty
printf 'Press any key (e.g. x) ...' > /dev/tty

KEY=$(dd bs=1 count=1 2>/dev/null < /dev/tty | od -An -tx1 -c | tr -s ' ')

printf '\033[?1049l' > /dev/tty
stty -f /dev/tty "$SAVED"
trap - EXIT INT TERM

echo "key:    raw byte read from /dev/tty ->${KEY}"
echo "screen: alternate screen exited, terminal settings restored"
echo "VERDICT: TTY handover WORKS — the fzf model (TUI on /dev/tty) is applicable"
