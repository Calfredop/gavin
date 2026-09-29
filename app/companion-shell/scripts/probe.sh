#!/bin/sh
# The bundle probe (companion-19), on a Simulator or an emulator.
#
#   scripts/probe.sh ios <simulator-udid>
#   scripts/probe.sh android <emulator-serial>
#
# Builds the hub and the Companion web bundle, embeds them with the probe,
# builds a DEBUG app, installs it on the device named, and launches it to
# run the probe: a bundle that tries, from inside the bundle webview, to
# call a Capacitor plugin -- the bundle view's and the Device's keys' --,
# to speak on the channel from a frame of another origin and from a
# subframe, to reach the network, and to navigate away. Prints the shell's
# verdict and exits 0 only when every check passed.
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

shell=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
log="$work/device.log"
. "$shell/scripts/device.sh"

build_and_install "$platform" "$target" "$work" --probe

case "$platform" in
  ios)
    # The launch argument lands in UserDefaults, where a DEBUG build looks.
    xcrun simctl launch --console-pty --terminate-running-process "$target" "$app_id" \
      -GavinBundleProbe YES >"$log" 2>&1 &
    watcher=$!
    ;;
  android)
    "$adb" -s "$target" logcat -c
    "$adb" -s "$target" logcat -v raw -s Capacitor/Console:* GavinShell:* >"$log" 2>&1 &
    watcher=$!
    "$adb" -s "$target" shell am start -S -n "$app_id/.MainActivity" --ez gavinBundleProbe true >/dev/null
    ;;
esac

stop_watching() {
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
}

i=0
while ! grep -q '\[gavin-probe\] {' "$log" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    stop_watching
    echo "no verdict after 90 s; the device log is in $log" >&2
    exit 1
  fi
  sleep 1
done
stop_watching

if [ "$platform" = android ]; then
  # ADR 0005: on Android the bundle's webview runs in a process of its own.
  shell_pid=$("$adb" -s "$target" shell pidof "$app_id" | tr -d '\r')
  bundle_pid=$("$adb" -s "$target" shell pidof "$app_id:bundle" | tr -d '\r')
  if [ -z "$bundle_pid" ] || [ "$bundle_pid" = "$shell_pid" ]; then
    echo "FAILED: the bundle did not run in its own process (shell $shell_pid, bundle ${bundle_pid:-none})"
    exit 1
  fi
  echo "the bundle ran in its own process: $app_id:bundle is pid $bundle_pid, the shell pid $shell_pid"
fi

grep -a -E "\[gavin-shell\]|GavinShell|dropped|blocked|refused" "$log" | grep -v '\[gavin-probe\]' || true
verdict=$(grep -a -o '\[gavin-probe\] {.*' "$log" | head -1 | sed 's/^\[gavin-probe\] //')
if grep -a -q "probe.invalid" "$log"; then
  echo "FAILED: a plugin call from the bundle reached one of the shell's plugins (it logged the probe's marked URL)"
  exit 1
fi
printf '%s' "$verdict" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    const verdict = JSON.parse(raw);
    for (const c of verdict.checks) console.log(`${c.passed ? "pass" : "FAIL"}  ${c.name}\n      ${c.detail}`);
    console.log(verdict.passed ? "\nThe bundle webview is sealed." : "\nThe probe FAILED.");
    process.exit(verdict.passed ? 0 : 1);
  });
'
