#!/bin/sh
# The scripted Unlock (companion-22): the shell, paired with two
# Workstations running on this Mac (scripts/devstack.mjs hub), unlocks
# once, connects to both, locks when sent to the background, and asks
# again when it comes back.
#
#   scripts/hub.sh ios <simulator-udid> [--screenshots <dir>]
#   scripts/hub.sh android <emulator-serial> --pin <pin> [--screenshots <dir>]
#
# 1. A fresh DEBUG install pairs with each Workstation in turn, the way
#    scripts/pair.sh does (a launch with the code in place of a scan).
# 2. A plain launch: the Unlock asks, once -- answered with a matching
#    face on the Simulator, the PIN on the emulator -- and both
#    Workstations must answer ready, with what their desks have waiting.
# 3. Another app is brought to the front: the Companion must lock, and
#    both Workstations with it.
# 4. The Companion is brought back: the Unlock asks again, and both
#    Workstations answer again.
#
# The node run of the same modules against the same stack is
# `scripts/pair.sh node` (src/shell/hub/hub.e2e.ts). What neither can
# show -- Control Center, a call banner, a real network dropping, a real
# Secure Enclave -- is the card's human test.
#
# The app is uninstalled first, keys and pairings with it: never point
# this at a Simulator you care about. Name devices by UDID or serial,
# never `booted`.
set -eu

platform=${1:-}
target=${2:-}
shell=$(cd "$(dirname "$0")/.." && pwd)

usage() {
  sed -n '7,8p' "$0" | sed 's/^# //'
  exit 2
}
case "$platform" in
  ios | android) [ -n "$target" ] || usage ;;
  *) usage ;;
esac
shift 2
pin=
shots=
while [ $# -gt 0 ]; do
  case "$1" in
    --pin) pin=$2; shift ;;
    --screenshots) shots=$2; mkdir -p "$shots"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

work=$(mktemp -d)
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

node "$shell/scripts/devstack.mjs" hub --work "$work" >"$work/desk.log" 2>&1 &
desk=$!
watcher=
stop_watching() {
  [ -n "$watcher" ] || return 0
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  watcher=
}
trap 'stop_watching; kill "$desk" 2>/dev/null || true' EXIT

fail() {
  echo "The scripted Unlock FAILED: $1. The logs are in $work." >&2
  exit 1
}

# Waits up to $2 seconds for the file $1 to hold a line matching $3, at
# least $4 times (default once).
await_line() {
  file=$1 seconds=$2 pattern=$3 times=${4:-1}
  i=0
  while [ "$(grep -a -c -E "$pattern" "$file" 2>/dev/null || true)" -lt "$times" ]; do
    kill -0 "$desk" 2>/dev/null || { cat "$work/desk.log"; fail "the desk stopped"; }
    i=$((i + 1))
    [ "$i" -le "$seconds" ] || fail "no \"$pattern\" in $file after ${seconds}s"
    sleep 1
  done
}

# Launches the app, with `$@` as what it is launched with, writing what it
# logs to the file named first.
launch() {
  out=$1
  shift
  stop_watching
  case "$platform" in
    ios)
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

# Answers the prompt on screen the way a person would.
answer() {
  sleep 2
  case "$platform" in
    ios) xcrun simctl spawn "$target" notifyutil -p com.apple.BiometricKit_Sim.pearl.match ;;
    android)
      [ -n "$pin" ] || fail "an emulator needs --pin to answer its prompt"
      "$adb" -s "$target" shell input text "$pin"
      "$adb" -s "$target" shell input keyevent KEYCODE_ENTER
      ;;
  esac
}

# Saves what the screen shows as $shots/$1.png, when asked to.
shoot() {
  [ -n "$shots" ] || return 0
  sleep 1
  case "$platform" in
    ios) xcrun simctl io "$target" screenshot "$shots/$1.png" >/dev/null 2>&1 ;;
    android) "$adb" -s "$target" exec-out screencap -p >"$shots/$1.png" ;;
  esac
}

# 1. Pair with each Workstation in turn.
ids=
for n in 0 1; do
  await_line "$work/desk.log" 600 "\\[desk $n\\] pairing code ready"
  if [ "$platform" = android ]; then
    port=$(node -e 'const u = new URL(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rendezvous[0]); console.log(u.port)' "$work/qr-$n")
    "$adb" -s "$target" reverse "tcp:$port" "tcp:$port" >/dev/null
  fi
  code=$(base64 <"$work/qr-$n" | tr -d '\n')
  if [ "$platform" = android ]; then launch "$work/phone-$n.log" --es gavinPairCode "$code"
  else launch "$work/phone-$n.log" -GavinPairCode "$code"; fi
  await_line "$work/phone-$n.log" 60 '\[gavin-pair\] phase confirming'
  answer
  await_line "$work/phone-$n.log" 90 '\[gavin-pair\] paired ws-'
  id=$(grep -a -o '\[gavin-pair\] paired ws-[a-z0-9]*' "$work/phone-$n.log" | head -1 | sed 's/.* paired //')
  echo "paired with Workstation $n: $id"
  ids="$ids $id"
done
await_line "$work/desk.log" 60 '\[desk\] both Workstations paired'
set -- $ids
first=$1 second=$2

# 2. One Unlock, both connected.
log="$work/unlock.log"
launch "$log"
await_line "$log" 60 '\[gavin-unlock\] foreground: locked \(not-yet\) -> unlocking'
shoot asking
answer
await_line "$log" 60 "\\[gavin-hub\\] $first: ready, 2 waiting"
await_line "$log" 60 "\\[gavin-hub\\] $second: ready, 1 waiting"
echo "one Unlock: both Workstations ready, 2 and 1 waiting"
shoot unlocked

# 3. Another app in front: locked.
case "$platform" in
  ios) xcrun simctl launch "$target" com.apple.Preferences >/dev/null ;;
  android) "$adb" -s "$target" shell input keyevent KEYCODE_HOME ;;
esac
await_line "$log" 30 '\[gavin-unlock\] background: unlocked -> locked \(background\)'
await_line "$log" 30 "\\[gavin-hub\\] $first: locked"
await_line "$log" 30 "\\[gavin-hub\\] $second: locked"
echo "in the background: locked, both Workstations dropped"

# 4. Back in front: asked again, connected again.
case "$platform" in
  ios) xcrun simctl launch "$target" "$app_id" >/dev/null ;;
  android) "$adb" -s "$target" shell am start -n "$app_id/.MainActivity" >/dev/null ;;
esac
await_line "$log" 30 '\[gavin-unlock\] foreground: locked \(background\) -> unlocking'
answer
await_line "$log" 60 "\\[gavin-hub\\] $first: ready, 2 waiting" 2
await_line "$log" 60 "\\[gavin-hub\\] $second: ready, 1 waiting" 2
prompts=$(grep -a -c 'DeviceKeys: asked to unlock' "$log" || true)
echo "back in front: asked again, both Workstations ready ($prompts Unlock prompts in all)"
shoot unlocked-again
[ "$prompts" -eq 2 ] || fail "expected 2 Unlock prompts, saw $prompts"
echo "The scripted Unlock passed."
