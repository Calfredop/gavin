#!/usr/bin/env bash
#
# What has to be true of a Gavin.app before anyone but its builder runs it.
#
#   scripts/verify-macos-bundle.sh <path to Gavin.app> [--allow-adhoc]
#
# The release job runs this without the flag, after `tauri build`, and a
# failure fails the release. That is the point: an unsigned or unstapled
# bundle is not something a human should have to notice, it is something the
# pipeline should refuse to publish.
#
# `--allow-adhoc` downgrades the two checks that need a real Developer ID
# (Gatekeeper assessment and the stapled notarization ticket) to warnings,
# so a developer can run everything else against a local `codesign -s -`
# build. Never pass it in CI.
#
# The checks, and why each one is here:
#
#   1. The sidecars are present. `resolve_daemon_binary_path` (daemon.rs)
#      and `resolve_mcp_binary_path` (agent_setup.rs) both join against
#      `current_exe().parent()`, so a bundle without them is a bundle that
#      fails at first launch. This was the state of `main` before the
#      audit's SC-08 fix, and it is the one check that also works on an
#      unsigned bundle.
#   2. The whole bundle verifies, --deep --strict. That is what makes a
#      swapped `Contents/MacOS/gavin-daemon` detectable at all (SC-07):
#      the sidecars sit beside the main binary, so the seal covers them.
#   3. Every Mach-O in Contents/MacOS carries the hardened runtime. Without
#      it there is no library validation, DYLD_INSERT_LIBRARIES works, and
#      a debugger can attach to the process that owns every session's PTY.
#   4. The embedded entitlements grant nothing. See entitlements.plist:
#      gavin needs no hardened-runtime exception, so every key there is
#      false, so a `<true/>` in the signed blob means someone widened the
#      runtime. If that is ever deliberate, this check changes in the same
#      commit that widens it.
#   5. One Team ID across all three binaries, and not "not set". A sidecar
#      signed by someone else is the supply-chain swap this whole exercise
#      is about.
#   6. Gatekeeper accepts it as notarized, and the ticket is stapled, so a
#      first launch works offline and without the "Open Anyway" habit that
#      makes a modified bundle indistinguishable from the real one.

set -uo pipefail

APP=""
ALLOW_ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --allow-adhoc) ALLOW_ADHOC=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) APP="$arg" ;;
  esac
done

if [ -z "$APP" ]; then
  echo "usage: $0 <path to Gavin.app> [--allow-adhoc]" >&2
  exit 2
fi
if [ ! -d "$APP" ]; then
  echo "not a bundle: $APP" >&2
  exit 2
fi

FAILED=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
warn() { printf '  warn  %s\n' "$1"; }

MACOS_DIR="$APP/Contents/MacOS"
SIDECARS="gavin-daemon gavin-mcp"
BINARIES="Gavin $SIDECARS"

echo "verifying $APP"

# 1. The sidecars shipped.
echo "[1] bundle contents"
for bin in $SIDECARS; do
  if [ -f "$MACOS_DIR/$bin" ]; then
    pass "$bin is beside the app binary"
  else
    fail "$bin is MISSING from Contents/MacOS -- the app cannot start (SC-08)"
  fi
done

# 2. The seal holds, nested code included.
echo "[2] signature"
if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/        /'; then
  pass "codesign --verify --deep --strict"
else
  fail "codesign --verify --deep --strict"
fi

# 3+5. Per-binary: hardened runtime, and one team.
echo "[3] hardened runtime and team identity"
TEAMS=""
for bin in $BINARIES; do
  path="$MACOS_DIR/$bin"
  [ -f "$path" ] || continue
  info=$(codesign --display --verbose=4 "$path" 2>&1)

  if printf '%s' "$info" | grep -q 'flags=.*runtime'; then
    pass "$bin: hardened runtime"
  else
    fail "$bin: NOT hardened ($(printf '%s' "$info" | grep -m1 '^CodeDirectory' || echo 'no code directory'))"
  fi

  team=$(printf '%s' "$info" | sed -n 's/^TeamIdentifier=//p' | head -1)
  case "$team" in
    ""|"not set")
      if [ "$ALLOW_ADHOC" = 1 ]; then
        warn "$bin: no Team ID (ad-hoc build)"
      else
        fail "$bin: no Team ID -- not signed with a Developer ID"
      fi
      ;;
    *) TEAMS="$TEAMS $team" ;;
  esac
done
# Unquoted on purpose: TEAMS is a space-separated accumulator, and an
# empty one has to count as zero teams, not as one empty line.
UNIQUE_TEAMS=$(for t in $TEAMS; do echo "$t"; done | sort -u)
COUNT=$(printf '%s' "$UNIQUE_TEAMS" | grep -c . || true)
case "$COUNT" in
  0) : ;;
  1) pass "one Team ID across the bundle: $UNIQUE_TEAMS" ;;
  *) fail "mixed Team IDs in one bundle: $(echo $UNIQUE_TEAMS)" ;;
esac

# 4. Entitlements grant nothing.
echo "[4] entitlements"
ENT=$(codesign --display --entitlements - --xml "$APP" 2>/dev/null)
if [ -z "$ENT" ]; then
  ENT=$(codesign --display --entitlements - "$APP" 2>/dev/null)
fi
if [ -z "$ENT" ]; then
  fail "no entitlements blob -- expected the one from src-tauri/entitlements.plist"
elif printf '%s' "$ENT" | grep -q '<true/>'; then
  fail "an entitlement is granted; gavin's are all false by design:"
  printf '%s' "$ENT" | sed 's/^/        /'
else
  pass "no entitlement granted"
fi

# 6. Gatekeeper and the notarization ticket.
echo "[5] Gatekeeper and notarization"
SPCTL=$(spctl --assess --type execute --verbose=4 "$APP" 2>&1)
if printf '%s' "$SPCTL" | grep -q 'accepted'; then
  pass "spctl: $(printf '%s' "$SPCTL" | grep -m1 'source=' | sed 's/^[[:space:]]*//')"
elif [ "$ALLOW_ADHOC" = 1 ]; then
  warn "spctl rejects it (expected for an ad-hoc build): $(printf '%s' "$SPCTL" | tr '\n' ' ')"
else
  fail "spctl rejects the bundle: $(printf '%s' "$SPCTL" | tr '\n' ' ')"
fi

STAPLE=$(xcrun stapler validate "$APP" 2>&1)
if printf '%s' "$STAPLE" | grep -q 'The validate action worked'; then
  pass "notarization ticket is stapled"
elif [ "$ALLOW_ADHOC" = 1 ]; then
  warn "no stapled ticket (expected for an ad-hoc build)"
else
  fail "no stapled ticket: $(printf '%s' "$STAPLE" | tr '\n' ' ')"
fi

echo
if [ "$FAILED" != 0 ]; then
  echo "NOT OK: do not distribute this bundle."
elif [ "$ALLOW_ADHOC" = 1 ]; then
  echo "OK for a local build. NOT distributable: --allow-adhoc waived the"
  echo "Developer ID, Gatekeeper and notarization checks, which are the"
  echo "three that decide whether anyone else can run this."
else
  echo "OK: this bundle is fit to hand to someone else."
fi
exit "$FAILED"
