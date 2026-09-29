#!/bin/sh
# The scripted pairing (companion-21): the shell pairs with a Workstation
# running on this Mac -- a real daemon, under a temporary $HOME, through a
# real Relay on loopback (scripts/devstack.mjs).
#
#   scripts/pair.sh node
#   scripts/pair.sh ios <simulator-udid> [--relay-host <ip>]
#   scripts/pair.sh android <emulator-serial> --pin <pin>
#
# node   The shell's own pairing module and the Companion core, in Node
#        (src/shell/pairing/pairing.e2e.ts): a pairing the desk confirms,
#        one it declines, and a second pairing on a spent code. And the
#        live hub (src/shell/hub/hub.e2e.ts): one phone paired with two
#        Workstations, one Unlock connecting both, a dropped connection
#        back without a prompt, a desktop app that quit, a Workstation
#        that left its Relay, and the Unlock ending on background.
# ios    Builds a DEBUG app, installs it fresh on the Simulator named, and
#        pairs it for real. The desk shows a code; the app is launched with
#        that code in place of a scan (a Simulator has no camera); the
#        Face ID prompt is answered with a matching face; and the desk
#        confirms only if the six digits the app shows are its own. Then
#        the app is launched again, and its hub must still list the
#        Workstation.
#        --relay-host puts the Relay on this Mac's LAN address instead of
#        loopback: what a real phone pairing with the dev desktop dials.
# android The same on an emulator: the Relay reached through
#        `adb reverse`, and the prompt answered with the screen-lock PIN
#        (set one with `adb -s <serial> shell locksettings set-pin <pin>`).
#
# The app is uninstalled first, which takes its Device keys and paired
# Workstations with it: never point this at a Simulator you care about.
# Name the device by UDID or serial, never `booted`: other sessions on this
# Mac boot simulators of their own, and a phone is often plugged in.
set -eu

platform=${1:-}
target=${2:-}
shell=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$shell/../.." && pwd)

usage() {
  sed -n '6,8p' "$0" | sed 's/^# //'
  exit 2
}

case "$platform" in
  node)
    (cd "$repo" && cargo build -q -p gavin-daemon -p gavin-relay --locked)
    node "$shell/scripts/core.mjs"
    cd "$shell" && GAVIN_E2E=1 exec npx vitest run
    ;;
  ios | android) [ -n "$target" ] || usage ;;
  *) usage ;;
esac
shift 2
pin=
relay_host=127.0.0.1
while [ $# -gt 0 ]; do
  case "$1" in
    --pin) pin=$2; shift ;;
    --relay-host) relay_host=$2; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

work=$(mktemp -d)
log="$work/device.log"
qr="$work/qr"
. "$shell/scripts/device.sh"

adb=${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb
case "$platform" in
  ios)
    xcrun simctl uninstall "$target" "$app_id" 2>/dev/null || true
    build_and_install ios "$target" "$work"
    xcrun simctl spawn "$target" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
    xcrun simctl spawn "$target" notifyutil -p com.apple.BiometricKit.enrollmentChanged
    ;;
  android)
    "$adb" -s "$target" uninstall "$app_id" >/dev/null 2>&1 || true
    build_and_install android "$target" "$work"
    ;;
esac

node "$shell/scripts/devstack.mjs" desk --qr-out "$qr" --phone-log "$log" --relay-host "$relay_host" >"$work/desk.log" 2>&1 &
desk=$!
trap 'kill "$desk" 2>/dev/null || true' EXIT

i=0
while [ ! -s "$qr" ]; do
  if ! kill -0 "$desk" 2>/dev/null; then
    cat "$work/desk.log"
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    echo "the desk made no pairing code in 10 minutes; its log is $work/desk.log" >&2
    kill "$desk" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Base64: UserDefaults would read a bare `{…}` launch argument as a
# property list, and `am start` would split it at its spaces.
code=$(base64 <"$qr" | tr -d '\n')

# Launches the app, with `$@` as what it is launched with, writing what it
# logs to the file named first.
launch() {
  out=$1
  shift
  case "$platform" in
    ios)
      # The launch arguments land in UserDefaults, where a DEBUG build looks.
      xcrun simctl launch --console-pty --terminate-running-process "$target" "$app_id" "$@" >"$out" 2>&1 &
      watcher=$!
      ;;
    android)
      "$adb" -s "$target" logcat -c
      "$adb" -s "$target" logcat -v raw -s Capacitor/Console:* GavinShell:* >"$out" 2>&1 &
      watcher=$!
      "$adb" -s "$target" shell am start -S -n "$app_id/.MainActivity" "$@" >/dev/null
      ;;
  esac
}

if [ "$platform" = android ]; then
  # The Relay is on this Mac's loopback; the emulator's own is its own.
  port=$(node -e 'const u = new URL(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rendezvous[0]); console.log(u.port)' "$qr")
  "$adb" -s "$target" reverse "tcp:$port" "tcp:$port" >/dev/null
  launch "$log" --es gavinPairCode "$code"
else
  launch "$log" -GavinPairCode "$code"
fi

stop_watching() {
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
}

answered=false
i=0
while kill -0 "$desk" 2>/dev/null; do
  if ! $answered && grep -q '\[gavin-pair\] phase confirming' "$log" 2>/dev/null; then
    # The prompt, answered the way a person would: a face on the
    # Simulator, the PIN on the emulator.
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
    answered=true
  fi
  i=$((i + 1))
  if [ "$i" -gt 180 ]; then
    echo "the pairing did not finish in 3 minutes; the logs are in $work" >&2
    kill "$desk" 2>/dev/null || true
    break
  fi
  sleep 1
done
desk_status=0
wait "$desk" || desk_status=$?
sleep 2
stop_watching

cat "$work/desk.log"
grep -a -o '\[gavin-pair\] .*' "$log" || true
paired=$(grep -a -o '\[gavin-pair\] paired [a-z0-9-]*' "$log" | head -1 | sed 's/.* paired //')
if [ "$desk_status" -ne 0 ] || [ -z "$paired" ]; then
  echo "The scripted pairing FAILED. The logs are in $work." >&2
  exit 1
fi

# A restart: the app launched again, with no code, must still list it.
relaunch="$work/relaunch.log"
launch "$relaunch"
i=0
while ! grep -q '\[gavin-shell\] hub lists' "$relaunch" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    stop_watching
    echo "the relaunched app said nothing about its hub; its log is $relaunch" >&2
    exit 1
  fi
  sleep 1
done
stop_watching
listed=$(grep -a -o '\[gavin-shell\] hub lists .*' "$relaunch" | head -1)
echo "$listed"
case "$listed" in
  *" $paired"*) echo "The scripted pairing passed: paired $paired, and still listed after a restart." ;;
  *)
    echo "The scripted pairing FAILED: $paired is not listed after a restart." >&2
    exit 1
    ;;
esac
