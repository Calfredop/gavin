#!/bin/sh
# Build and publish the Preview build of Gavin from this Mac.
#
# The Preview build (CONTEXT.md) is what a person installs before Gavin has
# a signed version: an unsigned macOS arm64 .dmg and an unsigned Windows x64
# setup .exe, both from `origin/main`'s committed tip, on one rolling GitHub
# pre-release tagged `preview` that each run replaces. It is NOT a release:
# `.github/workflows/release.yml` is still the signed, tag-triggered path,
# and nothing here touches it (docs/RELEASING.md, "Preview builds").
#
# Why each piece is the way it is:
#
# - Local, on this Mac. Both installers come out of one machine: the .dmg
#   natively, the .exe cross-compiled through cargo-xwin and Homebrew's
#   NSIS (app/src-tauri/BUNDLING.md, "Cross-compiling the Windows
#   installer").
# - A worktree of its own, at ~/Library/Caches/gavin-preview with its own
#   target/, never the shared checkout -- that tree carries every session's
#   half-finished edits -- and apart from install-release-mac.sh's
#   gavin-release, so the two never rebuild over each other.
# - Gates before anything is uploaded, each refusal naming its gate: the
#   commit is on origin/main (this fetches; it never pushes), ci.yml passed
#   on it (--force skips that one), and no other run holds the lock.
# - Fixed asset names, so the download address never changes:
#   Gavin-preview-macos-arm64.dmg and Gavin-preview-windows-x64-setup.exe.
#   The pre-release is never marked Latest -- the updater's endpoint reads
#   `releases/latest`, and a preview must not become what it offers.
#
# POSIX sh for the reason start-dev-mac.sh gives.
#
# Usage: scripts/publish-preview.sh [options]
#   --dry-run       build and stage both files with their notes; upload nothing
#   --ref REV       build REV instead of origin/main (only with --dry-run or a
#                   scratch --tag: the Preview build is origin/main's tip)
#   --force         skip the ci.yml gate
#   --tag TAG       publish to TAG instead of `preview` -- for proving the
#                   publish step; a scratch tag is not the Preview build, so
#                   the origin/main gate does not hold for it
#   --worktree DIR  where the build worktree lives
#                   (default: ~/Library/Caches/gavin-preview)

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REF=
TAG=preview
DRY_RUN=0
FORCE=0
WORKTREE="$HOME/Library/Caches/gavin-preview"
WIN_TRIPLE=x86_64-pc-windows-msvc
MAC_ASSET=Gavin-preview-macos-arm64.dmg
WIN_ASSET=Gavin-preview-windows-x64-setup.exe

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }
gate() { die "gate: $1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN=1; shift ;;
    --ref)      [ "$#" -ge 2 ] || die "--ref needs a value"; REF=$2; shift 2 ;;
    --force)    FORCE=1; shift ;;
    --tag)      [ "$#" -ge 2 ] || die "--tag needs a value"; TAG=$2; shift 2 ;;
    --worktree) [ "$#" -ge 2 ] || die "--worktree needs a value"; WORKTREE=$2; shift 2 ;;
    -h|--help)  sed -n '2,/^$/s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "macOS only: the .dmg needs this Mac's bundler."
[ "$(uname -m)" = arm64 ] || die "Apple silicon only: the .dmg is the host's arm64 build."
[ -z "$TAG" ] && die "--tag needs a non-empty value"
# The origin/main gate. A publish to `preview` builds origin/main as this
# run fetches it, so its commit is on origin/main by construction; the one
# way to build anything else is --ref, which is refused here.
if [ -n "$REF" ] && [ "$DRY_RUN" = 0 ] && [ "$TAG" = preview ]; then
  gate "origin/main -- the Preview build is origin/main's tip, and --ref $REF may not be. --ref is for --dry-run or a scratch --tag."
fi

case "$WORKTREE" in /*) ;; *) WORKTREE="$PWD/$WORKTREE" ;; esac
case "$WORKTREE/" in
  "$ROOT"/*) die "--worktree must be outside this checkout ($ROOT)" ;;
esac
OUT="$WORKTREE/target/preview"

# A Gavin tool runs this from the app, whose PATH is launchd's rather than a
# login shell's: cargo and Homebrew's tools have to be found by hand.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
case ":$PATH:" in *:/opt/homebrew/bin:*) ;; *) [ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH" ;; esac
export PATH

# --- prerequisites -------------------------------------------------------------

command -v cargo >/dev/null 2>&1 || die "cargo not found. Install Rust from https://rustup.rs (see docs/dev-setup.md)."
command -v node >/dev/null 2>&1 || die "node not found. Install Node 22 or newer."
command -v npm >/dev/null 2>&1 || die "npm not found. It ships with Node -- check the Node install."
xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools missing. Run: xcode-select --install"
command -v cargo-xwin >/dev/null 2>&1 || die "cargo-xwin not found (the Windows cross build). Run: cargo install --locked cargo-xwin"
command -v makensis >/dev/null 2>&1 || die "makensis not found (the Windows installer). Run: brew install makensis"
command -v 7zz >/dev/null 2>&1 || die "7zz not found (checks the installer's payload). Run: brew install sevenzip"
rustup target list --installed 2>/dev/null | grep -qx "$WIN_TRIPLE" \
  || die "the $WIN_TRIPLE target is missing. Run: rustup target add $WIN_TRIPLE"
if [ "$DRY_RUN" = 0 ]; then
  command -v gh >/dev/null 2>&1 || die "gh not found. Run: brew install gh"
  gh auth status >/dev/null 2>&1 || die "gh is not signed in. Run: gh auth login"
fi

# --- gate: one run at a time ---------------------------------------------------

# mkdir is atomic, so two runs cannot both take it. A lock whose pid is gone
# was left by a run that was killed, and is taken over rather than obeyed.
LOCK="$WORKTREE.lock"
take_lock() { mkdir -p "$(dirname -- "$LOCK")" && mkdir "$LOCK" 2>/dev/null && echo $$ > "$LOCK/pid"; }
if ! take_lock; then
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    gate "another Preview build run (pid $holder) holds $LOCK"
  fi
  note "taking over a stale lock from pid ${holder:-unknown}"
  rm -rf "$LOCK"
  take_lock || gate "another Preview build run took $LOCK just now"
fi
trap 'rm -rf "$LOCK"' EXIT
trap 'exit 130' INT TERM

# --- which commit ----------------------------------------------------------------

say "fetching origin"
git -C "$ROOT" fetch --quiet origin
REV=$(git -C "$ROOT" rev-parse --verify --quiet "${REF:-origin/main}^{commit}") \
  || die "${REF:-origin/main} is not a commit in $ROOT."
SHORT=$(git -C "$ROOT" rev-parse --short "$REV")
URL=$(git -C "$ROOT" remote get-url origin | sed -e 's#^git@github.com:#https://github.com/#' -e 's#\.git$##')
REPO=${URL#https://github.com/}
ON_MAIN=0
git -C "$ROOT" merge-base --is-ancestor "$REV" origin/main && ON_MAIN=1

# --- gate: CI ----------------------------------------------------------------------

# Before the build, not after it: a refusal costs seconds, not a build.
if [ "$DRY_RUN" = 1 ]; then
  note "dry run: nothing is published, so the ci.yml gate is not checked"
else
  if [ "$FORCE" = 1 ]; then
    note "--force: not checking ci.yml on $SHORT"
  else
    runs=$(gh run list --repo "$REPO" --workflow ci.yml --commit "$REV" --json status,conclusion \
      -q '.[] | "\(.status) \(.conclusion)"' 2>/dev/null) \
      || gate "could not ask GitHub for ci.yml runs on $SHORT (pass --force to skip)"
    if printf '%s\n' "$runs" | grep -qx 'completed success'; then
      note "ci.yml passed on $SHORT"
    elif printf '%s\n' "$runs" | grep -v '^completed' | grep -q .; then
      gate "ci.yml is still running on $SHORT -- wait for it (or pass --force)"
    elif [ -n "$runs" ]; then
      gate "ci.yml did not pass on $SHORT (pass --force to publish anyway)"
    else
      gate "no ci.yml run on $SHORT (pass --force to publish anyway)"
    fi
  fi
fi

# --- worktree ---------------------------------------------------------------------

if [ -e "$WORKTREE/.git" ]; then
  [ -z "$(git -C "$WORKTREE" status --porcelain --untracked-files=no)" ] \
    || die "the build worktree $WORKTREE has local changes. Nothing should edit it; reset it or remove it and re-run."
  if [ "$(git -C "$WORKTREE" rev-parse HEAD)" != "$REV" ]; then
    say "moving the build worktree to $SHORT"
    git -C "$WORKTREE" checkout --quiet --detach "$REV"
  fi
else
  [ ! -e "$WORKTREE" ] || [ -z "$(ls -A "$WORKTREE")" ] \
    || die "$WORKTREE exists and is not a worktree. Move it aside or pass --worktree."
  git -C "$ROOT" worktree prune
  say "cutting the build worktree at $WORKTREE from $SHORT"
  mkdir -p "$(dirname -- "$WORKTREE")"
  git -C "$ROOT" worktree add --quiet --detach "$WORKTREE" "$REV"
fi

APP_DIR="$WORKTREE/app"
TARGET="$WORKTREE/target"
VERSION=$(node -p 'require(process.argv[1]).version' "$APP_DIR/src-tauri/tauri.conf.json")
# What bundle.mjs stamps when GAVIN_BUILD_NUMBER is unset, as it is below.
BUILD=$(git -C "$WORKTREE" rev-list --count HEAD)

# --- build ------------------------------------------------------------------------

stamp="$APP_DIR/node_modules/.publish-preview-lock"
if [ -f "$stamp" ] && cmp -s "$stamp" "$APP_DIR/package-lock.json"; then
  say "frontend dependencies match the lockfile"
else
  say "installing frontend dependencies (npm ci)"
  (cd "$APP_DIR" && npm ci)
  cp "$APP_DIR/package-lock.json" "$stamp"
fi

# A bundle directory left from an earlier commit would let a stale installer
# pass for this one, so each is emptied before its build.
MAC_BUNDLE="$TARGET/release/bundle"
WIN_BUNDLE="$TARGET/$WIN_TRIPLE/release/bundle"
rm -rf "$MAC_BUNDLE/macos" "$MAC_BUNDLE/dmg" "$WIN_BUNDLE/nsis"

# GAVIN_BUILD_NUMBER is cleared so the number is the worktree's own commit
# count; CI=true keeps the .dmg step from scripting Finder to lay out its
# window, which needs a desktop session a Gavin tool run may not have.
say "building the macOS bundle and .dmg, ad-hoc signed (gavin $VERSION, build $BUILD)"
(
  cd "$APP_DIR"
  unset GAVIN_BUILD_NUMBER
  CARGO_TARGET_DIR="$TARGET" APPLE_SIGNING_IDENTITY=- CI=true \
    node src-tauri/bundle.mjs --bundles app,dmg
)
say "verifying the macOS bundle"
sh "$ROOT/scripts/verify-macos-bundle.sh" "$MAC_BUNDLE/macos/Gavin.app" --allow-adhoc

# LC_ALL: Homebrew's makensis aborts with std::bad_alloc on the first Exch or
# Pop it compiles under the C locale -- which is what a session with no LANG
# has -- and builds normally under a UTF-8 one.
say "cross-compiling the Windows installer ($WIN_TRIPLE through cargo-xwin)"
(
  cd "$APP_DIR"
  unset GAVIN_BUILD_NUMBER
  CARGO_TARGET_DIR="$TARGET" LC_ALL=en_US.UTF-8 node src-tauri/bundle.mjs --runner cargo-xwin --target "$WIN_TRIPLE"
)

# --- stage ------------------------------------------------------------------------

one() {
  # The single file matching $1, or a refusal naming the directory.
  set -- $1
  [ "$#" = 1 ] && [ -f "$1" ] || die "expected exactly one $(basename -- "$1") from the build, found: $*"
  printf '%s\n' "$1"
}
dmg=$(one "$MAC_BUNDLE/dmg/*.dmg")
exe=$(one "$WIN_BUNDLE/nsis/*-setup.exe")
# An NSIS installer is a 32-bit stub whatever it installs, so the 64-bit
# check is on its payload: the app and both sidecars, each PE32+ x86-64.
file -b "$exe" | grep -q 'Nullsoft Installer' || die "$exe is not an NSIS installer: $(file -b "$exe")"
payload="$TARGET/preview-payload"
rm -rf "$payload"
7zz x -y -o"$payload" "$exe" Gavin.exe gavin-daemon.exe gavin-mcp.exe >/dev/null \
  || die "could not unpack the installer's payload from $exe"
for bin in Gavin.exe gavin-daemon.exe gavin-mcp.exe; do
  [ -f "$payload/$bin" ] || die "the Windows installer does not carry $bin"
  file -b "$payload/$bin" | grep -q '^PE32+ executable.*x86-64' \
    || die "$bin in the installer is not a PE32+ x86-64 executable: $(file -b "$payload/$bin")"
done
rm -rf "$payload"
note "installer carries Gavin.exe, gavin-daemon.exe and gavin-mcp.exe, each PE32+ x86-64"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$dmg" "$OUT/$MAC_ASSET"
cp "$exe" "$OUT/$WIN_ASSET"

cat > "$OUT/notes.md" <<EOF
The Preview build of Gavin: **unsigned** installers from \`main\`, replaced on every publish. It is not a release and has no version of its own.

| | |
|---|---|
| Commit | [\`$SHORT\`]($URL/commit/$REV) |
| Build | $BUILD (gavin $VERSION) |
| Built | $(date -u '+%Y-%m-%d %H:%M UTC') |

### macOS (Apple silicon)

1. Download \`$MAC_ASSET\`, open it and drag Gavin into Applications.
2. The app is not signed by Apple, so macOS will refuse to open it until you clear the quarantine flag. In Terminal:

   \`\`\`
   xattr -dr com.apple.quarantine /Applications/Gavin.app
   \`\`\`
3. Open Gavin.

### Windows (x64)

1. Download \`$WIN_ASSET\` and run it.
2. The installer is not signed, so SmartScreen stops it: choose **More info**, then **Run anyway**.

Gavin on Windows needs Git for Windows and the WebView2 runtime (Windows 11 ships it).
EOF

say "staged in $OUT"
ls -l "$OUT" | sed 1d | sed 's/^/    /'

if [ "$DRY_RUN" = 1 ]; then
  say "dry run: nothing uploaded"
  exit 0
fi

# --- publish -----------------------------------------------------------------------

# Replaced, not edited: deleting the release and its tag and creating both
# again leaves no asset or note from the previous run behind. The tag is
# created on GitHub at the built commit -- by the API, not a push. A commit
# GitHub does not have (a scratch tag's local --ref) leaves the tag on the
# default branch's tip instead, and says so.
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  say "deleting the previous $TAG release and its tag"
  gh release delete "$TAG" --repo "$REPO" --cleanup-tag --yes
fi
target_flag="--target=$REV"
if [ "$ON_MAIN" = 0 ] && ! git -C "$ROOT" branch -r --contains "$REV" 2>/dev/null | grep -q .; then
  note "$SHORT is not on GitHub: the $TAG tag goes on the default branch's tip"
  target_flag=
fi
say "publishing $TAG ($SHORT, build $BUILD)"
# shellcheck disable=SC2086
gh release create "$TAG" --repo "$REPO" "$OUT/$MAC_ASSET" "$OUT/$WIN_ASSET" \
  $target_flag --prerelease --latest=false \
  --title "Gavin Preview build $BUILD" --notes-file "$OUT/notes.md" \
  || die "creating the $TAG release failed after the previous one was deleted. Re-run to publish it."
say "done: $URL/releases/tag/$TAG"
