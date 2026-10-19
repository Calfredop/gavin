#!/bin/sh
# OS task-snapshot cover (companion-shell:os-task-snapshot-retains-workstation-view-after-unlock-ends).
#
#   scripts/snapshot.sh ios <simulator-udid>
#   scripts/snapshot.sh android <emulator-serial> --pin <pin>
#
# Pairs a DEBUG Companion with an isolated Workstation (devstack snapshot),
# unlocks so the hub shows SNAPSHOT-MARKER in the attention inbox, opens the
# Workstation's marker bundle (stand-in for a terminal), backgrounds the app
# past the Unlock grace, and checks that the OS task snapshot / Recents card
# does not still show the marker.
#
# Name the device by UDID or serial, never `booted`. The app is uninstalled
# first. Fingerprint: companion-shell:os-task-snapshot-retains-workstation-view-after-unlock-ends
set -eu

MARKER=SNAPSHOT-MARKER
platform=${1:-}
target=${2:-}
shell=$(cd "$(dirname "$0")/.." && pwd)

usage() {
  sed -n '4,5p' "$0" | sed 's/^# //'
  exit 2
}
case "$platform" in
  ios | android) [ -n "$target" ] || usage ;;
  *) usage ;;
esac
shift 2
pin=
while [ $# -gt 0 ]; do
  case "$1" in
    --pin) pin=$2; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

work=$(mktemp -d)
. "$shell/scripts/device.sh"
adb=${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb
ocr_bin="$work/snapshot-ocr"
swiftc -O -o "$ocr_bin" "$shell/scripts/snapshot-ocr.swift"

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

node "$shell/scripts/devstack.mjs" snapshot --work "$work" >"$work/desk.log" 2>&1 &
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
  echo "The task-snapshot check FAILED: $1. Logs in $work." >&2
  exit 1
}

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
      "$adb" -s "$target" shell am start -S -n "$app_id/.MainActivity" >/dev/null
      ;;
  esac
}

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

contains_marker() {
  img=$1
  "$ocr_bin" "$img" 2>/dev/null | tr '[:lower:]' '[:upper:]' | grep -q "$MARKER"
}

# Whether the Companion currently shows the marker (UI tree on Android —
# setRecentsScreenshotEnabled can make adb screencap a black frame).
foreground_has_marker() {
  case "$platform" in
    ios)
      capture_fg
      contains_marker "$work/fg.png"
      ;;
    android)
      "$adb" -s "$target" shell uiautomator dump /sdcard/gavin-ui.xml >/dev/null
      "$adb" -s "$target" pull /sdcard/gavin-ui.xml "$work/fg-ui.xml" >/dev/null
      grep -q "$MARKER" "$work/fg-ui.xml"
      ;;
  esac
}

# 1. Pair.
await_line "$work/desk.log" 600 "pairing code ready"
if [ "$platform" = android ]; then
  port=$(node -e 'const u = new URL(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rendezvous[0]); console.log(u.port)' "$work/qr")
  "$adb" -s "$target" reverse "tcp:$port" "tcp:$port" >/dev/null
fi
code=$(base64 <"$work/qr" | tr -d '\n')
if [ "$platform" = android ]; then
  android_debug_clear
  android_debug_request pair-code "$code"
  launch "$work/phone.log"
else
  launch "$work/phone.log" -GavinPairCode "$code"
fi
await_line "$work/phone.log" 60 '\[gavin-pair\] phase confirming'
answer
await_line "$work/phone.log" 90 '\[gavin-pair\] paired ws-'
ws=$(grep -a -o '\[gavin-pair\] paired ws-[a-z0-9]*' "$work/phone.log" | head -1 | sed 's/.* paired //')
await_line "$work/desk.log" 60 "desktop shows $MARKER"
echo "paired with $ws"

# Capture the OS task snapshot after leaving long enough for the Unlock to end.
capture_task_image() {
  out=$1
  case "$platform" in
    ios)
      # Do not bring the Companion back: that replaces the SplashBoard frame.
      # SplashBoard can take several seconds to write the .ktx after resign.
      j=0
      while [ "$j" -lt 5 ]; do
        if xcrun simctl launch "$target" com.apple.Preferences >/dev/null 2>"$work/prefs.err"; then
          break
        fi
        j=$((j + 1))
        sleep 2
      done
      [ "$j" -lt 5 ] || fail "could not launch Preferences to background the Companion ($(cat "$work/prefs.err" 2>/dev/null))"
      container=$(xcrun simctl get_app_container "$target" "$app_id" data)
      newest=
      i=0
      while [ "$i" -lt 20 ]; do
        newest=$(find "$container/Library/SplashBoard/Snapshots" "$container/Library/Caches/Snapshots" \
          -type f \( -name '*.ktx' -o -name '*.png' -o -name '*.jpeg' -o -name '*.jpg' \) 2>/dev/null \
          | xargs ls -t 2>/dev/null | head -1 || true)
        [ -n "$newest" ] && break
        i=$((i + 1))
        sleep 1
      done
      [ -n "$newest" ] || fail "no on-disk iOS SplashBoard/Caches snapshot under $container"
      echo "iOS snapshot file: $newest" >&2
      case "$newest" in
        *.png | *.jpeg | *.jpg) cp "$newest" "$out" ;;
        *)
          # Apple's AAPL .ktx: sips / ImageIO read it; ImageMagick does not.
          sips -s format png "$newest" --out "$out" >/dev/null 2>&1 \
            || fail "sips could not convert $newest (leave the iOS verdict to the human test)"
          ;;
      esac
      ;;
    android)
      "$adb" -s "$target" shell input keyevent KEYCODE_HOME
      sleep 5
      "$adb" -s "$target" shell input keyevent KEYCODE_APP_SWITCH
      sleep 1
      "$adb" -s "$target" shell screencap -p /sdcard/gavin-recents.png >/dev/null
      "$adb" -s "$target" pull /sdcard/gavin-recents.png "$out" >/dev/null
      ;;
  esac
}

# On a userdebug/google_apis AVD, pull the newest Recents task bitmap via adb root.
try_android_task_bitmaps() {
  out=$1
  "$adb" -s "$target" root >/dev/null 2>&1 || return 1
  sleep 1
  newest=$("$adb" -s "$target" shell \
    'find /data/system_ce/0 /data/misc_ce/0 /data/system -type f \( -name "*.jpg" -o -name "*.png" \) -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -1 | cut -d" " -f2-' \
    | tr -d '\r')
  [ -n "$newest" ] || return 1
  "$adb" -s "$target" pull "$newest" "$out" >/dev/null 2>&1 || return 1
  echo "android task bitmap: $newest" >&2
  return 0
}

check_no_marker() {
  label=$1
  img="$work/$label.png"
  capture_task_image "$img"
  if contains_marker "$img"; then
    fail "$label still shows $MARKER (see $img)"
  fi
  # Play-store AVDs often give a solid black Recents screencap (with or
  # without the fix). That must not count as a pass — try root bitmaps, else
  # require OCR to have seen some Recents chrome.
  if [ "$platform" = android ]; then
    ocr_out=$("$ocr_bin" "$img" 2>/dev/null || true)
    if [ -z "$(printf '%s' "$ocr_out" | tr -d '[:space:]')" ]; then
      if try_android_task_bitmaps "$work/$label-task.png" \
        && ! contains_marker "$work/$label-task.png"; then
        echo "pass  $label: on-disk task bitmap has no $MARKER"
        return 0
      fi
      fail "$label: Recents screencap is blank (cannot OCR task thumbnails on this AVD). Use a google_apis/userdebug image with adb root, or the human test on a phone."
    fi
  fi
  echo "pass  $label: OS task image has no $MARKER"
}

# 2. Unlock: hub shows the marker in the attention inbox (no open-first yet).
log="$work/unlock.log"
launch "$log"
await_line "$log" 60 '\[gavin-unlock\] foreground: locked \(not-yet\) -> unlocking'
answer
await_line "$log" 60 "\\[gavin-hub\\] $ws: ready,"
sleep 2
# Wait until the marker is painted (inbox can lag the "ready" log line).
i=0
while [ "$i" -lt 30 ]; do
  if foreground_has_marker; then
    echo "hub shows $MARKER"
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -lt 30 ] || fail "hub did not show $MARKER before backgrounding"
check_no_marker hub-inbox

# 3. Bundle case: relaunch with open-first so the marker page is drawn.
case "$platform" in
  ios)
    launch "$work/bundle.log" -GavinOpenFirst YES
    ;;
  android)
    android_debug_clear
    android_debug_request open-first
    launch "$work/bundle.log"
    ;;
esac
await_line "$work/bundle.log" 60 '\[gavin-unlock\] foreground:.* -> unlocking'
answer
await_line "$work/bundle.log" 60 "\\[gavin-hub\\] $ws: ready,"
log="$work/bundle.log"
i=0
while [ "$i" -lt 60 ]; do
  if foreground_has_marker; then
    if [ "$platform" = ios ]; then
      xcrun simctl io "$target" screenshot "$work/fg.png" >/dev/null 2>&1 || true
      if "$ocr_bin" "$work/fg.png" 2>/dev/null | grep -q 'gavin@workstation'; then
        echo "Workstation marker bundle is on screen"
        break
      fi
    elif grep -q 'gavin@workstation' "$work/fg-ui.xml" 2>/dev/null; then
      echo "Workstation marker bundle is on screen"
      break
    fi
    if [ "$i" -ge 20 ]; then
      echo "marker visible (hub or bundle); proceeding"
      break
    fi
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -lt 60 ] || fail "could not get $MARKER on screen for the bundle case"
check_no_marker bundle-terminal

echo "The task-snapshot check passed: neither the unlocked hub nor the Workstation frame leaked $MARKER."
