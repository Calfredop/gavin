#!/usr/bin/env bash
# Drive a debug build of the Companion on a physical iPhone, over USB:
# the Simulator scripts tap and screenshot through simctl, which a real
# phone does not have, so this reaches the page through Web Inspector.
#
#   scripts/device-drive.sh ios-device <udid>                   # install, launch, then inspector
#   scripts/device-drive.sh ios-device <udid> install           # build, install, launch
#   scripts/device-drive.sh ios-device <udid> launch
#   scripts/device-drive.sh ios-device <udid> inspector [--port <port>]  # default 9322
#   scripts/device-drive.sh ios-device <udid> eval [<page>]     # the script on stdin
#   scripts/device-drive.sh ios-device <udid> dom [<page>]
#   scripts/device-drive.sh ios-device <udid> click <label> [<page>]
#
# <page> is the start of the page's URL: `capacitor://localhost` (the
# hub, the default) or `gavin-bundle://` (a Workstation's bundle).
#
# install signs with DEVELOPMENT_TEAM from the environment (never commit
# it) and needs the phone trusted, with Developer Mode on. inspector, eval,
# dom and click need the app in front on an unlocked phone, and Settings >
# Apps > Safari > Advanced > Web Inspector on. Nothing here can answer Face
# ID: an Unlock on a real phone waits for its owner.
#
# inspector serves the page as Chrome DevTools Protocol on 127.0.0.1 only
# (device-inspector.py) and stops itself unless the port refuses every LAN
# address of this Mac. Never use `ios_webkit_debug_proxy` for this: it
# listens on every interface and has no bind option, so the webview --
# the Device's Noise key, a live Workstation connection -- answers the LAN.
# eval, dom and click open no port at all (webview-eval.py).
#
# pymobiledevice3 is installed once into its own venv under the user's
# cache (GAVIN_DEVICE_VENV to put it elsewhere).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
shell=$(cd "$here/.." && pwd)
app_id=com.gavin.companion
usage() {
  sed -n '6,12p' "$0" | sed 's/^# //' >&2
  exit 64
}

[ "${1:-}" = ios-device ] || usage
udid=${2:-}
[ -n "$udid" ] || usage
action=${3:-all}
shift $(($# < 3 ? $# : 3))

cache=${XDG_CACHE_HOME:-$HOME/Library/Caches}/gavin-companion
venv=${GAVIN_DEVICE_VENV:-$cache/device-venv}
venv_python() {
  if [ ! -x "$venv/bin/python" ]; then
    python3 -m venv "$venv"
    "$venv/bin/pip" install -q "pymobiledevice3==11.26.0"
  fi
}

# The script on stdin, evaluated in the page; INFO and DEBUG lines dropped.
page_eval() {
  venv_python
  "$venv/bin/python" -I "$here/webview-eval.py" "$udid" "$1" 2> >(grep -v -E " (INFO|DEBUG) " >&2)
}

json_string() {
  python3 -I -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"
}

# What a person could press: visible buttons, links and role=button, by
# their text or, failing that, their aria-label.
pressables='[...document.querySelectorAll("button, a[href], [role=button]")]
  .filter(el => el.getClientRects().length > 0)
  .map(el => [el, (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ")])
  .filter(([, label]) => label)'

launch() {
  xcrun devicectl device process launch --device "$udid" --terminate-existing "$app_id" >/dev/null
  echo "launched $app_id"
}

install() {
  [ -n "${DEVELOPMENT_TEAM:-}" ] || {
    echo "install signs with your team: DEVELOPMENT_TEAM=<team id> $0 ios-device $udid install" >&2
    exit 2
  }
  work=$cache/device-build
  mkdir -p "$work"
  (cd "$shell/.." && npm run --silent companion-shell:sync -- ios >"$work/sync.log" 2>&1) || {
    cat "$work/sync.log"
    exit 1
  }
  (cd "$shell/ios/App" && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
    -destination "id=$udid" -derivedDataPath "$work/dd" -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" build >"$work/build.log" 2>&1) || {
    grep -E "error:" "$work/build.log" || tail -20 "$work/build.log"
    exit 1
  }
  xcrun devicectl device install app --device "$udid" "$work/dd/Build/Products/Debug-iphoneos/App.app" >/dev/null
  echo "installed a debug build on $udid"
  launch
}

inspector() {
  port=9322
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port=$2; shift ;;
      *) usage ;;
    esac
    shift
  done
  # 9222 is everyone's DevTools port (an `adb forward` sits there), and a
  # check against a port someone else answers proves nothing.
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already taken: --port <another>" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
    exit 1
  fi
  venv_python
  # Python itself in the background, not a function: $! must be the pid
  # that holds the socket, or lsof below measures nothing and the stop
  # trap orphans the server.
  "$venv/bin/python" -I "$here/device-inspector.py" "$udid" "$port" 2> >(grep -v -E " (INFO|DEBUG) " >&2) &
  pid=$!
  trap 'kill $pid 2>/dev/null || true' EXIT INT TERM
  # The bind is the whole point, so measure it rather than trust it: every
  # socket this process listens on is loopback, and every LAN address of
  # this Mac is refused.
  listening=
  for _ in $(seq 100); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid" || true; exit 1; }
    listening=$(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn | sed -n 's/^n//p' || true)
    [ -n "$listening" ] && break
    sleep 0.2
  done
  [ -n "$listening" ] || { echo "the inspector did not start listening" >&2; exit 1; }
  if [ "$listening" != "127.0.0.1:$port" ]; then
    echo "REFUSING: the inspector listens on $listening, not 127.0.0.1:$port only" >&2
    exit 1
  fi
  for ip in $(ifconfig | awk '$1 == "inet" && $2 !~ /^127\./ { print $2 }'); do
    if curl -s -o /dev/null --max-time 2 "http://$ip:$port/json"; then
      echo "REFUSING: http://$ip:$port/json answered from the LAN" >&2
      exit 1
    fi
    echo "refused from $ip:$port"
  done
  echo "Web Inspector on http://127.0.0.1:$port/ (CDP: /json), loopback only; ^C stops it"
  curl -s "http://127.0.0.1:$port/json" | python3 -I -c '
import json, sys
for t in json.load(sys.stdin):
    print("  %s  %s" % (t.get("url"), t.get("webSocketDebuggerUrl")))
'
  wait "$pid"
}

case "$action" in
  all)
    install
    inspector "$@"
    ;;
  install) install ;;
  launch) launch ;;
  inspector) inspector "$@" ;;
  eval) page_eval "${1:-capacitor://localhost}" ;;
  dom)
    page_eval "${1:-capacitor://localhost}" <<EOF
location.href + "\n\n" + document.body.innerText.trim() + "\n\npressable:\n"
  + $pressables.map(([, l]) => "  [" + (l.length > 80 ? l.slice(0, 79) + "…" : l) + "]").join("\n")
EOF
    ;;
  click)
    [ -n "${1:-}" ] || usage
    label=$(json_string "$1")
    # The one label that is the text, else the one that starts with it,
    # else the one that contains it. The click is synthetic (untrusted),
    # which a Svelte handler does not check.
    out=$(page_eval "${2:-capacitor://localhost}" <<EOF
(() => {
  const all = $pressables;
  const hit = [(l) => l === $label, (l) => l.startsWith($label), (l) => l.includes($label)]
    .map((match) => all.filter(([, l]) => match(l)))
    .find((found) => found.length) || [];
  const short = (l) => "[" + (l.length > 60 ? l.slice(0, 59) + "…" : l) + "]";
  if (hit.length !== 1) return hit.length
    ? "ambiguous: " + $label + " is " + hit.length + " buttons:\n  " + hit.map(([, l]) => short(l)).join("\n  ")
    : "no such button: " + $label + "\npressable:\n  " + all.map(([, l]) => short(l)).join("\n  ");
  hit[0][0].click();
  return "clicked [" + hit[0][1] + "]";
})()
EOF
    )
    echo "$out"
    case "$out" in clicked*) ;; *) exit 1 ;; esac
    ;;
  *) usage ;;
esac
