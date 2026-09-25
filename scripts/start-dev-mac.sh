#!/bin/sh
# Start the Gavin desktop app in dev mode on macOS.
#
# The primary dev flow from `docs/dev-setup.md`, in one command: prerequisite
# checks, `npm ci` when the checkout has no `node_modules`, the daemon and MCP
# binaries the app auto-spawns as siblings of its own binary, then
# `npm run tauri dev`.
#
# POSIX sh, not bash or zsh: this is started by hand on whatever the
# developer's machine calls a shell, the same reason `app/vite-cache-guard.sh`
# gives.
#
# Usage: scripts/start-dev-mac.sh [extra args forwarded to `tauri dev`]

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$ROOT/app"
OS=$(uname -s)

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$OS" = "Darwin" ] ||
  printf 'note: written for macOS; continuing on %s anyway.\n' "$OS"

# rustup installs into the home directory and updates the shell profile, so a
# shell that was already open when it ran still has no cargo on PATH.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

command -v cargo >/dev/null 2>&1 ||
  die "cargo not found. Install Rust from https://rustup.rs (see docs/dev-setup.md)."
command -v node >/dev/null 2>&1 ||
  die "node not found. Install Node 22 or newer (nvm, Homebrew, or nodejs.org)."
command -v npm >/dev/null 2>&1 ||
  die "npm not found. It ships with Node -- check the Node install."

# Tauri links against the system frameworks through cc; without the command
# line tools that failure lands in the middle of a cargo build instead. Only
# macOS has this to check -- elsewhere the compiler came from a package
# manager and cargo says so itself.
if [ "$OS" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  die "Xcode command line tools missing. Run: xcode-select --install"
fi

if [ ! -d "$APP/node_modules" ]; then
  say "installing frontend dependencies (npm ci)"
  (cd "$APP" && npm ci)
fi

# tauri.conf.json's beforeDevCommand runs this same script. Running it here
# first means a Rust error is the last thing on screen when it happens,
# instead of being scrolled away by vite and the app window.
#
# Through dev-sidecars.mjs and not a bare `cargo build` so that all three dev
# entry points share one definition of how the sidecars get built. Nothing it
# does is needed here -- unlinking a running image is ordinary on this host --
# but the bug it fixes was this one cargo line copied into three files, and a
# second copy is how the next divergence starts.
say "building gavin-daemon and gavin-mcp"
node "$APP/src-tauri/dev-sidecars.mjs"

say "starting the app (npm run tauri dev)"
cd "$APP"
if [ "$#" -gt 0 ]; then
  exec npm run tauri dev -- "$@"
fi
exec npm run tauri dev
