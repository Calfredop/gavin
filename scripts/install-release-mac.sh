#!/bin/sh
# Build and install the release Gavin on this Mac, out of reach of the dev tree.
#
# The macOS counterpart of start-release-win.ps1, on the same recipe
# (.gavin-root/plans/archive/chore-stable-release-install-on-windows.md): a
# release build, cut from a detached worktree that no agent types in, copied
# into /Applications. Nothing the installed app runs points back at this
# checkout afterwards -- the frontend is embedded in the binary, gavin-daemon
# and gavin-mcp sit beside it in Contents/MacOS, and a release daemon binds
# daemon.sock where a dev one binds daemon-dev.sock -- so editing, rebuilding
# or `tauri dev`-reloading gavin here never restarts it. Upgrading is running
# this script again, and it is the only thing that does.
#
# Why each piece:
#
# - A worktree, not this checkout. The shared tree carries every session's
#   half-finished edits and often does not compile; a release build is cut
#   from a commit (`main`'s tip unless --ref says otherwise).
# - Outside this checkout's folder by default (~/Library/Caches). The
#   worktree holds its own target/ -- several GB of release artefacts -- and
#   a sibling folder would sit in whatever syncs this one.
# - Its own target/, forced. A CARGO_TARGET_DIR inherited from the caller
#   would put the release build's objects back in a tree the dev build writes.
# - Ad-hoc signed (APPLE_SIGNING_IDENTITY=-), then checked with
#   verify-macos-bundle.sh --allow-adhoc: the bundle is sealed with its two
#   sidecars, hardened, and granted no entitlement, the same as a release
#   minus the Developer ID. See docs/RELEASING.md.
# - Through `npm run bundle`'s script (app/src-tauri/bundle.mjs), so the
#   install carries the same version and build number a bundle built any
#   other way would: CFBundleShortVersionString is `version` in
#   tauri.conf.json, CFBundleVersion the commit count of what was built.
# - `--bundles app`: the .dmg step drives Finder and is only for handing
#   the build to someone else.
# - Swapped in by rename. A running Gavin and its daemon keep the files they
#   started from, so installing never kills a session. They move to the new
#   build when you quit Gavin and use Restart daemon -- the human's call,
#   because that ends every PTY the daemon holds.
#
# POSIX sh for the reason start-dev-mac.sh gives.
#
# Usage: scripts/install-release-mac.sh [options]
#   --ref REV        commit to build (default: main)
#   --worktree DIR   where the build worktree lives
#                    (default: ~/Library/Caches/gavin-release)
#   --dest DIR       where Gavin.app goes (default: /Applications)
#   --skip-build     install the worktree's last build as it is
#   --open           launch Gavin afterwards if it is not already running

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

REF=main
DEFAULT_WORKTREE="$HOME/Library/Caches/gavin-release"
WORKTREE=$DEFAULT_WORKTREE
DEST=/Applications
SKIP_BUILD=0
OPEN=0

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) [ "$#" -ge 2 ] || die "--ref needs a value"; REF=$2; shift 2 ;;
    --worktree) [ "$#" -ge 2 ] || die "--worktree needs a value"; WORKTREE=$2; shift 2 ;;
    --dest) [ "$#" -ge 2 ] || die "--dest needs a value"; DEST=$2; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --open) OPEN=1; shift ;;
    -h|--help) sed -n '2,/^$/s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "macOS only. On Windows use scripts/start-release-win.ps1."

# A relative --worktree or --dest would resolve against wherever the caller
# stood, and the worktree's own commands below run from other directories.
case "$WORKTREE" in /*) ;; *) WORKTREE="$PWD/$WORKTREE" ;; esac
case "$DEST" in /*) ;; *) DEST="$PWD/$DEST" ;; esac

case "$WORKTREE/" in
  "$ROOT"/*) die "--worktree must be outside this checkout ($ROOT), or the dev tree's tooling can reach it." ;;
esac

# Only ever a worktree of THIS repository: what this script does to one
# would otherwise move some other repo's HEAD.
ours_common=$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
is_our_worktree() {
  [ -e "$1/.git" ] &&
    [ "$(cd "$1" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" = "$ours_common" ]
}

# This script was install-stable-mac.sh, and its worktree gavin-stable. One
# cut under the old name is moved rather than abandoned: it holds a release
# target/ and node_modules that are minutes of build to replace, and left
# where it is it would stay registered against this repository for nothing.
LEGACY_WORKTREE="$HOME/Library/Caches/gavin-stable"
if [ "$WORKTREE" = "$DEFAULT_WORKTREE" ] && [ ! -e "$WORKTREE" ] && is_our_worktree "$LEGACY_WORKTREE"; then
  say "moving the build worktree from $LEGACY_WORKTREE to $WORKTREE"
  git -C "$ROOT" worktree move "$LEGACY_WORKTREE" "$WORKTREE"
fi

BUILT="$WORKTREE/target/release/bundle/macos/Gavin.app"
INSTALLED="$DEST/Gavin.app"

# --- prerequisites ------------------------------------------------------------

if [ "$SKIP_BUILD" = 0 ]; then
  if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  command -v cargo >/dev/null 2>&1 ||
    die "cargo not found. Install Rust from https://rustup.rs (see docs/dev-setup.md)."
  command -v node >/dev/null 2>&1 ||
    die "node not found. Install Node 22 or newer."
  command -v npm >/dev/null 2>&1 ||
    die "npm not found. It ships with Node -- check the Node install."
  xcode-select -p >/dev/null 2>&1 ||
    die "Xcode command line tools missing. Run: xcode-select --install"
fi

# --- the worktree ---------------------------------------------------------------

if [ "$SKIP_BUILD" = 1 ]; then
  say "skipping the build (--skip-build)"
else
  REV=$(git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}") ||
    die "$REF is not a commit in $ROOT."

  if [ -e "$WORKTREE/.git" ]; then
    is_our_worktree "$WORKTREE" ||
      die "$WORKTREE is a checkout of another repository. Pass --worktree."

    # It is a build cache. Local edits there mean someone used it for
    # something else; never carry them into a build or throw them away.
    if [ -n "$(git -C "$WORKTREE" status --porcelain --untracked-files=no)" ]; then
      die "$WORKTREE has local changes. Commit or discard them there, then re-run."
    fi
    if [ "$(git -C "$WORKTREE" rev-parse HEAD)" = "$REV" ]; then
      say "build worktree already at $REF ($REV)"
    else
      say "moving the build worktree to $REF ($REV)"
      git -C "$WORKTREE" checkout --quiet --detach "$REV"
    fi
  else
    [ ! -e "$WORKTREE" ] || [ -z "$(ls -A "$WORKTREE")" ] ||
      die "$WORKTREE exists and is not a worktree. Move it aside or pass --worktree."
    # A worktree whose folder was deleted (a cache cleaner, say) is still
    # registered, and `worktree add` refuses its path until it is pruned.
    git -C "$ROOT" worktree prune
    say "cutting the build worktree at $WORKTREE from $REF ($REV)"
    mkdir -p "$(dirname -- "$WORKTREE")"
    git -C "$ROOT" worktree add --quiet --detach "$WORKTREE" "$REV"
  fi

  # --- the build ----------------------------------------------------------------

  APP_DIR="$WORKTREE/app"

  # `npm ci` wipes and refills node_modules, which is minutes of nothing when
  # the lockfile has not moved since the last build. The stamp records which
  # lockfile the tree was installed from.
  stamp="$APP_DIR/node_modules/.install-release-lock"
  if [ -f "$stamp" ] && cmp -s "$stamp" "$APP_DIR/package-lock.json"; then
    say "frontend dependencies match the lockfile"
  else
    say "installing frontend dependencies (npm ci)"
    (cd "$APP_DIR" && npm ci)
    cp "$APP_DIR/package-lock.json" "$stamp"
  fi

  # `npm run bundle` with an ad-hoc identity and the .app target alone.
  # GAVIN_BUILD_NUMBER is cleared so the number is the worktree's own commit
  # count, never one leaked in from the caller's environment.
  say "building the release bundle (a fresh worktree compiles everything: expect several minutes)"
  (
    cd "$APP_DIR"
    unset GAVIN_BUILD_NUMBER
    CARGO_TARGET_DIR="$WORKTREE/target" APPLE_SIGNING_IDENTITY=- \
      node src-tauri/bundle.mjs --bundles app
  )
fi

[ -d "$BUILT" ] || die "no build at $BUILT. Run without --skip-build."

say "verifying the bundle"
sh "$ROOT/scripts/verify-macos-bundle.sh" "$BUILT" --allow-adhoc ||
  die "the bundle failed verification -- not installing it."

# --- install -----------------------------------------------------------------------

[ -d "$DEST" ] || mkdir -p "$DEST"
[ -w "$DEST" ] ||
  die "$DEST is not writable by $(id -un). Pass --dest \"\$HOME/Applications\" (scripts/gavin-mcp looks there first)."

# Matched on the executable's PATH, never its name: the dev tree's daemon is
# also called gavin-daemon, and it is none of this script's business.
running() {
  ps -axo pid=,comm= | awk -v dir="$INSTALLED/Contents/MacOS/" \
    'index($0, dir) { sub(/^ */, ""); print }'
}
before=$(running)

say "installing into $INSTALLED"
staging="$DEST/.Gavin.app.installing.$$"
previous="$DEST/.Gavin.app.previous.$$"
rm -rf "$staging"
ditto "$BUILT" "$staging"
if [ -e "$INSTALLED" ]; then
  mv "$INSTALLED" "$previous"
fi
mv "$staging" "$INSTALLED"
rm -rf "$previous"

plist="$INSTALLED/Contents/Info.plist"
note "Gavin $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist") (build $(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist"))"
if [ "$SKIP_BUILD" = 0 ]; then
  note "built from $(git -C "$WORKTREE" log -1 --format='%h %s' HEAD)"
fi

if [ -n "$before" ]; then
  say "these are still running the previous build:"
  printf '%s\n' "$before" | sed 's/^/    /'
  note "Quit Gavin and start it again for the new app. The daemon keeps every"
  note "session on the old build until you use Settings > Restart daemon,"
  note "which ends those sessions."
elif [ "$OPEN" = 1 ]; then
  # Through LaunchServices, so the app does not inherit this shell's
  # environment -- an agent session's CLAUDE_* variables included.
  say "launching Gavin"
  open "$INSTALLED"
else
  say "done. Start it from $INSTALLED (or re-run with --open)."
fi
