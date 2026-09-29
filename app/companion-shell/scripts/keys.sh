#!/bin/sh
# The keys check (companion-20), on a Simulator or an emulator.
#
#   scripts/keys.sh ios <simulator-udid> [--strict] [--expect <outcome>]
#   scripts/keys.sh android <emulator-serial> [--strict] [--pin <pin>] [--expect <outcome>]
#
# Builds a DEBUG app, installs it on the device named, and launches it to
# run the keys check (src/shell/keys/keysCheck.ts). On a phone that can be
# a Device it creates both keys, reads them back, has the hardware key sign
# a handshake hash -- answering the prompt that brings up -- verifies the
# signature, and deletes the keys. On one that cannot, it checks the plugin
# refuses too. Prints the verdict and exits 0 only when every check passed
# (and, with --expect, only when the outcome is the one named). Any keys the
# app already held are deleted: never point it at a phone that has paired.
#
#   --strict   refuse a software key, as a release build does. A Simulator
#              or an emulator then has no hardware keystore to offer.
#   --pin      Android: the screen-lock PIN, typed into the prompt. Set one
#              first with `adb -s <serial> shell locksettings set-pin <pin>`;
#              an emulator with none is refused for having no passcode.
#   --expect   the outcome, e.g. "ready: software-debug",
#              "refused: no-passcode", "refused: no-hardware-keystore".
#
# On iOS the script enrols Face ID on the Simulator named and answers the
# prompt with a matching face.
#
# Name the device by UDID or serial, never `booted`: other sessions on this
# Mac boot simulators of their own.
set -eu

platform=${1:-}
target=${2:-}
if [ -z "$platform" ] || [ -z "$target" ]; then
  sed -n '4,5p' "$0" | sed 's/^# //'
  exit 2
fi
shift 2
strict=false
pin=
expect=
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) strict=true ;;
    --pin) pin=$2; shift ;;
    --expect) expect=$2; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

shell=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
log="$work/device.log"
. "$shell/scripts/device.sh"

build_and_install "$platform" "$target" "$work"

case "$platform" in
  ios)
    xcrun simctl spawn "$target" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
    xcrun simctl spawn "$target" notifyutil -p com.apple.BiometricKit.enrollmentChanged
    # The launch arguments land in UserDefaults, where a DEBUG build looks.
    if $strict; then strict_arg=YES; else strict_arg=NO; fi
    xcrun simctl launch --console-pty --terminate-running-process "$target" "$app_id" \
      -GavinKeysCheck YES -GavinStrictKeys "$strict_arg" >"$log" 2>&1 &
    watcher=$!
    ;;
  android)
    "$adb" -s "$target" logcat -c
    "$adb" -s "$target" logcat -v raw -s Capacitor/Console:* GavinShell:* >"$log" 2>&1 &
    watcher=$!
    "$adb" -s "$target" shell am start -S -n "$app_id/.MainActivity" \
      --ez gavinKeysCheck true --ez gavinStrictKeys "$strict" >/dev/null
    ;;
esac

stop_watching() {
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
}

# The prompt, answered the way a person would: a face on the Simulator,
# the PIN on the emulator.
answer_prompt() {
  sleep 2
  case "$platform" in
    ios) xcrun simctl spawn "$target" notifyutil -p com.apple.BiometricKit_Sim.pearl.match ;;
    android)
      if [ -n "$pin" ]; then
        "$adb" -s "$target" shell input text "$pin"
        "$adb" -s "$target" shell input keyevent KEYCODE_ENTER
      fi
      ;;
  esac
}

answered=false
i=0
while ! grep -q '\[gavin-keys\] {' "$log" 2>/dev/null; do
  if ! $answered && grep -q '\[gavin-keys\] prompting' "$log" 2>/dev/null; then
    answer_prompt
    answered=true
  fi
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    stop_watching
    echo "no verdict after 90 s; the device log is in $log" >&2
    exit 1
  fi
  sleep 1
done
stop_watching

grep -a -E "\[gavin-shell\]|GavinShell" "$log" | grep -v '\[gavin-keys\]' || true
verdict=$(grep -a -o '\[gavin-keys\] {.*' "$log" | head -1 | sed 's/^\[gavin-keys\] //')
printf '%s' "$verdict" | EXPECT="$expect" node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    const verdict = JSON.parse(raw);
    for (const c of verdict.checks) console.log(`${c.passed ? "pass" : "FAIL"}  ${c.name}\n      ${c.detail}`);
    const expected = process.env.EXPECT;
    const outcomeOk = !expected || verdict.outcome === expected;
    console.log(`\noutcome: ${verdict.outcome}` + (outcomeOk ? "" : ` (expected ${expected})`));
    console.log(verdict.passed && outcomeOk ? "The keys check passed." : "The keys check FAILED.");
    process.exit(verdict.passed && outcomeOk ? 0 : 1);
  });
'
