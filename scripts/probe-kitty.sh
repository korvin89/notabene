#!/bin/sh
# References of the form "DESIGN.md §N" below point to the original design document;
# on 2026-09-14 it was folded into ARCHITECTURE.md and DECISIONS.md. The probe text
# is left as is.
# Flow B probe (DESIGN.md §8.5): kitty as "the place where the viewer lives".
#
#   ! sh scripts/probe-kitty.sh          — stages 1-2, quick, no involvement from you
#   ! sh scripts/probe-kitty.sh full     — plus stage 3: the full cycle with a real review
#
# Requires in ~/.config/kitty/kitty.conf:
#     allow_remote_control socket-only
#     listen_on unix:/tmp/kitty
# and a RESTART of kitty (the socket is created at startup).

PROBE=/tmp/claude-diff-probe
KITTY=/Applications/kitty.app/Contents/MacOS/kitty
[ -x "$KITTY" ] || KITTY=kitty

echo "=== Flow B probe: kitty remote control from under \`!\` ==="
echo "KITTY_PID=${KITTY_PID:-none}  KITTY_WINDOW_ID=${KITTY_WINDOW_ID:-none}"
echo "KITTY_LISTEN_ON=${KITTY_LISTEN_ON:-<not set>}"

# --- socket address: env first, then assemble it from the PID ---
TO="$KITTY_LISTEN_ON"
if [ -z "$TO" ] && [ -n "$KITTY_PID" ]; then
  for cand in "/tmp/kitty-$KITTY_PID" "${TMPDIR%/}/kitty-$KITTY_PID"; do
    [ -S "$cand" ] && { TO="unix:$cand"; break; }
  done
fi

if [ -z "$TO" ]; then
  echo
  echo "VERDICT: no socket. Add to ~/.config/kitty/kitty.conf:"
  echo "    allow_remote_control socket-only"
  echo "    listen_on unix:/tmp/kitty"
  echo "and restart kitty completely (not just a new window)."
  exit 1
fi
echo "address: $TO"

# --- stage 1: does remote control work without a controlling terminal ---
echo
echo "--- stage 1: kitty @ ls via the socket ---"
if OUT=$("$KITTY" @ --to "$TO" ls 2>&1); then
  echo "stage1: OK, windows/tabs visible: $(printf '%s' "$OUT" | grep -c '"id"')"
else
  echo "stage1: FAILED -> $OUT"
  echo "VERDICT: remote control does not respond. Flow B is not viable; flows A and C remain."
  exit 1
fi

# --- stage 2: blocking tab launch ---
#
# WARNING (T5, 2026-09-14): the result of this stage has been REFUTED by a live run.
# In the same kitty 0.48.2, the `kitten @` client with `--wait-for-child-to-exit` stopped
# returning control at all — reproduced on the `sh -c 'sleep 1'` dummy
# for all launch types. The product waits by polling `ls --match id:<wid>`
# (src/launcher/kitty.ts, DESIGN.md §8.5). The probe is kept as a record of the experiment;
# if you run it today, stages 2 and 3 may hang — interrupt with Ctrl-C.
echo
echo "--- stage 2: launch --wait-for-child-to-exit (the tab closes itself after 2 s) ---"
T0=$(date +%s)
RC=$("$KITTY" @ --to "$TO" launch --type=tab --title "claude-diff probe" \
     --wait-for-child-to-exit sh -c 'printf "probe: this tab lives for 2 seconds\n"; sleep 2' 2>&1)
T1=$(date +%s)
echo "stage2: exit code='${RC}' elapsed=$((T1-T0)) s"
if [ "$RC" = "0" ] && [ $((T1-T0)) -ge 2 ]; then
  echo "stage2: OK — the launch is blocking, the exit code arrives"
else
  echo "stage2: suspicious (expected code 0 and >=2 s)"
fi

if [ "$1" != "full" ]; then
  echo
  echo "VERDICT (stages 1-2): the flow B mechanics work."
  echo "Full cycle with a real review:  ! sh scripts/probe-kitty.sh full"
  exit 0
fi

# --- stage 3: full cycle — the viewer in a tab, comments back into stdout ---
echo
echo "--- stage 3: full cycle ---"
# IMPORTANT: `kitty @ launch` runs the command in the environment of kitty ITSELF
# (with a GUI launch that is PATH=/usr/bin:/bin:/usr/sbin:/sbin, shell rc files were never
# read), not in ours. Hence the absolute path + the explicit PATH pass-through.
# `--copy-env` does not help: per the docs it does not copy variables set by rc files.
HUNK=$(command -v hunk 2>/dev/null)
[ -n "$HUNK" ] || { echo "hunk not found in PATH"; exit 1; }
echo "hunk: $HUNK"

rm -rf "$PROBE" && mkdir -p "$PROBE/repo"
printf 'export const KB = 4;\nexport function hit(t) {\n  return t.hp - 10;\n}\nconst OLD_CRIT = true;\n' > "$PROBE/repo/weapons.ts"
printf '# balance\n- crit agreed\n- knockback\n' > "$PROBE/repo/balance.md"
( cd "$PROBE/repo" \
  && git init -q \
  && git add -A \
  && git -c user.email=probe@local -c user.name=probe commit -qm base \
  && printf 'export const KB = 4;\nexport function hit(t, kb) {\n  return t.hp - 10 * kb;\n}\n' > weapons.ts \
  && printf '# balance\n- knockback\n- new rule\n' > balance.md )

EXT="$(cd "$(dirname "$0")" && pwd)/probe-kitty-ext"
if [ ! -d "$EXT" ]; then
  # The probe extension was deleted after the MVP was closed: its scheme moved into the product.
  echo "stage 3 cannot run: $EXT was deleted after the MVP was closed."
  echo "The live equivalent of stage 3 is a regular product run: !ntb in kitty"
  echo "(the extension is src/hunk-ext/; it requires the NOTABENE_HANDOFF env from the CLI)."
  exit 0
fi
echo "fixture: $PROBE/repo   extension: $EXT"
echo
echo ">>> A tab with hunk is about to open. Leave a couple of comments and exit (q)."
echo ">>> To comment: move onto a line and press the start-note key (see ? in hunk)."
echo

T0=$(date +%s)
RC=$("$KITTY" @ --to "$TO" launch --type=tab --title "claude-diff review" --cwd "$PROBE/repo" \
     --env "PATH=$PATH" --env "HOME=$HOME" \
     --wait-for-child-to-exit "$HUNK" diff --extension "$EXT" 2>&1)
T1=$(date +%s)
echo "the viewer closed: code='${RC}' elapsed=$((T1-T0)) s"

echo
echo "--- collected comments ($PROBE/notes.json) ---"
if [ -f "$PROBE/notes.json" ]; then
  cat "$PROBE/notes.json"
  N=$(grep -c '"id"' "$PROBE/notes.json" 2>/dev/null || echo 0)
  echo
  echo "VERDICT: the full flow B cycle passed, comments collected: $N"
  echo "(0 is also a success of the mechanics: an empty review -> an empty batch, as the spec requires)"
else
  echo "no file"
  echo "VERDICT: the viewer ran, but the extension did not write the comments — investigate extension loading"
fi
