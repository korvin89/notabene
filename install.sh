#!/bin/sh
# notabene installer — and its own updater: re-running it updates in place.
#
#   curl -fsSL https://raw.githubusercontent.com/korvin89/notabene/main/install.sh | sh
#
# There is no build step (ARCHITECTURE.md §6): Node 22.18+ runs the TypeScript
# directly, so installing is a git clone plus `npm ci` for the pinned viewer.
# That is also why the source must NOT land under a `node_modules` directory —
# Node refuses to strip types there (DECISIONS.md D25), which rules out
# `npm install -g` and is the reason this script exists.
#
# Everything lives under one directory the installer owns and marks; `ntb update`
# later works on that same directory and refuses to touch anything else.
#
# Overrides: NOTABENE_REPO, NOTABENE_ROOT, NOTABENE_BINDIR, NOTABENE_REF.
set -eu

REPO=${NOTABENE_REPO:-https://github.com/korvin89/notabene.git}
ROOT=${NOTABENE_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/notabene}
BINDIR=${NOTABENE_BINDIR:-$HOME/.local/bin}
REF=${NOTABENE_REF:-}

MARKER_NAME=.managed-install

# Everything is diagnostics: a piped `curl | sh` has no stdout contract, but
# keeping stderr consistent with the CLI costs nothing.
say() { printf '%s\n' "$*" >&2; }
die() {
	printf 'install: %s\n' "$*" >&2
	exit 1
}

# --- preflight ---------------------------------------------------------------

for tool in git node npm; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool not found in PATH — install it first (node must be 22.18+)"
done

node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 18) ? 0 : 1)' \
	|| die "node $(node -v) is too old: notabene runs TypeScript directly, which needs 22.18+"

case $(uname -s) in
Darwin) ;;
*) say "warning: only macOS is supported today (see README) — continuing anyway" ;;
esac

# --- fetch -------------------------------------------------------------------

if [ -e "$ROOT" ]; then
	# Never adopt a directory we did not create: it may be a developer's checkout
	# with unfinished work, and `checkout` below would discard it.
	[ -f "$ROOT/$MARKER_NAME" ] \
		|| die "$ROOT exists but was not created by this installer — remove it, or set NOTABENE_ROOT to another path"
	say "updating $ROOT"
	git -C "$ROOT" remote set-url origin "$REPO"
	git -C "$ROOT" fetch --quiet --tags --prune origin
else
	say "cloning $REPO into $ROOT"
	mkdir -p "$(dirname "$ROOT")"
	git clone --quiet "$REPO" "$ROOT" || die "clone failed — is $REPO reachable?"
fi

if [ -z "$REF" ]; then
	REF=$(git -C "$ROOT" tag --list --sort=-v:refname | head -n 1)
fi

if [ -n "$REF" ]; then
	git -C "$ROOT" -c advice.detachedHead=false checkout --quiet "$REF" \
		|| die "no such ref in $REPO: $REF"
else
	# An unreleased repository: no tags yet, so track the default branch.
	branch=$(git -C "$ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||') || branch=
	[ -n "$branch" ] || branch=main
	say "no tags yet — installing branch $branch"
	git -C "$ROOT" checkout --quiet "$branch"
	git -C "$ROOT" reset --quiet --hard "origin/$branch"
	REF=$branch
fi

# --- dependencies ------------------------------------------------------------

# The viewer is a ~100 MB standalone binary pulled in as a platform package, so
# this is the slow step. `--omit=dev` skips tsc/@types — nothing runtime needs them.
say "installing dependencies (the hunk viewer is ~100 MB — this takes a moment)"
(cd "$ROOT" && npm ci --omit=dev --no-audit --no-fund --silent) \
	|| die "npm ci failed in $ROOT"

printf 'Installed by install.sh. `ntb update` manages this directory.\n' > "$ROOT/$MARKER_NAME"

# --- link --------------------------------------------------------------------

mkdir -p "$BINDIR"

link() {
	target=$BINDIR/$1
	if [ -L "$target" ]; then
		current=$(readlink "$target")
		[ "$current" = "$ROOT/ntb" ] \
			|| die "$target already points at $current — remove it, or set NOTABENE_BINDIR"
	elif [ -e "$target" ]; then
		die "$target already exists and is not our symlink — remove it, or set NOTABENE_BINDIR"
	fi
	ln -sf "$ROOT/ntb" "$target"
}

# Two names on one wrapper: `ntb` is canonical, `notabene` spelled out also works.
link ntb
link notabene

# --- report ------------------------------------------------------------------

say ""
say "installed $("$ROOT/ntb" --version) ($REF) in $ROOT"

case ":$PATH:" in
*":$BINDIR:"*)
	shadow=$(command -v ntb 2>/dev/null) || shadow=
	if [ -n "$shadow" ] && [ "$shadow" != "$BINDIR/ntb" ]; then
		say "warning: another ntb comes first in PATH: $shadow"
	fi
	say "run  !ntb  inside a Claude Code session to review the current turn"
	;;
*)
	say ""
	say "$BINDIR is not in your PATH. Add this to your shell rc, then reopen the shell:"
	say "    export PATH=\"$BINDIR:\$PATH\""
	;;
esac
