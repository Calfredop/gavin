#!/usr/bin/env bash
# Build a debug Companion from this checkout and put it on every phone
# plugged into this Mac: Android through adb, iPhones through devicectl.
# It looks first, then syncs and builds only the platforms it found.
#
#   scripts/usb-install.sh                          # every phone on USB
#   scripts/usb-install.sh --list                   # what it found, then stop
#   scripts/usb-install.sh --only <serial-or-udid>  # just that one (repeatable)
#   scripts/usb-install.sh --network                # iPhones paired over Wi-Fi too
#   scripts/usb-install.sh --team <TEAM_ID>         # iPhone signing team
#   scripts/usb-install.sh --no-launch
#
# An iPhone build is signed with --team, else DEVELOPMENT_TEAM, else the
# team the last iPhone build here succeeded with (remembered in the user's
# cache, never in the repo). It must be a paid team Xcode is signed in to:
# the app's entitlements carry aps-environment, which a personal team
# cannot sign (docs/companion-mobile.md). A team that cannot sign drops
# the iPhones before any build and the Android phones still get theirs.
# The phone must be trusted, with Developer Mode on. An Android phone
# needs USB debugging allowed for this Mac.
#
# A debug build cannot replace a store build (the signatures differ). The
# script says so and leaves the old app alone: uninstalling it by hand
# deletes the Device's keys, so every Workstation must pair it again.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
shell=$(cd "$here/.." && pwd)
app=$(cd "$shell/.." && pwd)
app_id=com.gavin.companion
usage() {
  sed -n '6,11p' "$0" | sed 's/^# //' >&2
  exit 64
}

list=
network=
launch=1
team=${DEVELOPMENT_TEAM:-}
team_from=${DEVELOPMENT_TEAM:+DEVELOPMENT_TEAM}
only=()
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list=1 ;;
    --network) network=1 ;;
    --no-launch) launch= ;;
    --team) [ $# -ge 2 ] || usage; team=$2; team_from=--team; shift ;;
    --only) [ $# -ge 2 ] || usage; only+=("$2"); shift ;;
    *) usage ;;
  esac
  shift
done

cache=${XDG_CACHE_HOME:-$HOME/Library/Caches}/gavin-companion
ios_work=$cache/device-build
android_work=$cache/android-build
mkdir -p "$ios_work" "$android_work"

wanted() {
  [ ${#only[@]} -eq 0 ] && return 0
  local id
  for id in "${only[@]}"; do [ "$id" = "$1" ] && return 0; done
  return 1
}

# --- what is plugged in -------------------------------------------------

# Gradle finds the SDK only through ANDROID_HOME (or a local.properties
# nobody commits), so it is exported from where the SDK is.
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}
[ ! -d "$sdk" ] || export ANDROID_HOME=$sdk
adb=$sdk/platform-tools/adb
[ -x "$adb" ] || adb=$(command -v adb || true)

android=()
if [ -n "$adb" ]; then
  # A phone on a cable carries `usb:`; an emulator or wireless debugging
  # does not, and is not this script's.
  while read -r serial state rest; do
    case " $rest " in *" usb:"*) ;; *) continue ;; esac
    wanted "$serial" || continue
    model=$(printf '%s\n' "$rest" | tr ' ' '\n' | sed -n 's/^model://p')
    case "$state" in
      device)
        android+=("$serial")
        echo "android  $serial  ${model:-?}  usb"
        ;;
      unauthorized) echo "android  $serial  ${model:-?}  SKIPPED: allow USB debugging on the phone, then run again" >&2 ;;
      *) echo "android  $serial  ${model:-?}  SKIPPED: adb says $state" >&2 ;;
    esac
  done < <("$adb" devices -l | tail -n +2)
else
  echo "no adb: Android phones not looked for (ANDROID_HOME)" >&2
fi

ios=()
if xcrun --find devicectl >/dev/null 2>&1; then
  json=$ios_work/devices.json
  xcrun devicectl list devices -q --json-output "$json" >/dev/null 2>&1 || : >"$json"
  # udid, transport, name, and why it cannot take a build ("" when it can).
  while IFS=$'\t' read -r udid transport name blocked; do
    wanted "$udid" || continue
    if [ -n "$blocked" ]; then
      echo "ios      $udid  $name  SKIPPED: $blocked" >&2
    elif [ "$transport" = wired ] || { [ -n "$network" ] && [ "$transport" = localNetwork ]; }; then
      ios+=("$udid")
      echo "ios      $udid  $name  $transport"
    elif [ "$transport" = localNetwork ]; then
      echo "ios      $udid  $name  SKIPPED: paired over Wi-Fi, not USB (--network to include it)" >&2
    fi
  done < <(python3 -I - "$json" <<'EOF'
import json, sys
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    devices = []
for d in devices:
    hw, conn, props = d.get("hardwareProperties", {}), d.get("connectionProperties", {}), d.get("deviceProperties", {})
    if hw.get("reality") != "physical" or hw.get("platform") != "iOS":
        continue
    transport = conn.get("transportType") or "unavailable"
    blocked = ""
    if conn.get("pairingState") != "paired":
        blocked = "not paired: unlock it and trust this Mac"
    elif props.get("developerModeStatus") == "disabled":
        blocked = "Developer Mode is off (Settings > Privacy & Security)"
    elif transport not in ("wired", "localNetwork"):
        continue
    name = "%s (%s, iOS %s)" % (props.get("name", "?"), hw.get("marketingName", "?"), props.get("osVersionNumber", "?"))
    print("\t".join([hw.get("udid") or d["identifier"], transport, name, blocked]))
EOF
  )
else
  echo "no devicectl (Xcode 15 or later): iPhones not looked for" >&2
fi

if [ ${#android[@]} -eq 0 ] && [ ${#ios[@]} -eq 0 ]; then
  echo "no phone to install on" >&2
  exit 1
fi
[ -z "$list" ] || exit 0

# --- signing, before a minute of web build ------------------------------

failed=()
installed=()
remembered=$cache/ios-team

# The teams Xcode is signed in to, one per line: id, paid|free, name.
xcode_teams() {
  defaults export com.apple.dt.Xcode - 2>/dev/null | python3 -I -c '
import plistlib, sys
try:
    accounts = plistlib.loads(sys.stdin.buffer.read()).get("IDEProvisioningTeamByIdentifier", {})
except Exception:
    accounts = {}
seen = set()
for teams in accounts.values():
    for t in teams:
        if t.get("teamID") in seen:
            continue
        seen.add(t.get("teamID"))
        print("%s\t%s\t%s" % (t.get("teamID"), "free" if t.get("isFreeProvisioningTeam") else "paid", t.get("teamName", "?")))
' | sort -t$'\t' -k2,2 -k3
}

# Why $team cannot sign this app, or nothing when it can.
team_problem() {
  local teams row
  teams=$(xcode_teams)
  if [ -z "$team" ]; then
    echo "no signing team: pass --team <TEAM_ID> (or DEVELOPMENT_TEAM)"
  elif [ -z "$teams" ]; then
    return 0 # no accounts readable here: let xcodebuild say
  else
    row=$(printf '%s\n' "$teams" | awk -F'\t' -v t="$team" '$1 == t')
    if [ -z "$row" ]; then
      echo "Xcode is not signed in to team $team ($team_from): Xcode > Settings > Accounts, or --team another"
    elif [ "$(printf '%s' "$row" | cut -f2)" = free ]; then
      echo "team $team ($team_from) is a personal team, which cannot sign Push Notifications: --team a paid one"
    else
      return 0
    fi
  fi
}

if [ ${#ios[@]} -gt 0 ]; then
  if [ -z "$team" ] && [ -s "$remembered" ]; then
    team=$(cat "$remembered")
    team_from="the last iPhone build here"
  fi
  problem=$(team_problem)
  if [ -n "$problem" ]; then
    printf '%s\n' "$problem" >&2
    for udid in "${ios[@]}"; do failed+=("ios $udid (signing)"); done
    ios=()
    [ ${#android[@]} -gt 0 ] || { printf 'FAILED     %s\n' "${failed[@]}" >&2; exit 1; }
  else
    echo "signing iPhone builds with team $team ($team_from)"
  fi
fi

# --- build once per platform ------------------------------------------

platforms=()
[ ${#android[@]} -eq 0 ] || platforms+=(android)
[ ${#ios[@]} -eq 0 ] || platforms+=(ios)

[ -d "$shell/node_modules/@capacitor/cli" ] || (cd "$shell" && npm ci)
[ -d "$app/node_modules" ] || (cd "$app" && npm ci)
rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown

echo "→ sync ${platforms[*]} (web builds, $(git -C "$app" rev-parse --short HEAD)$(git -C "$app" diff --quiet HEAD -- . && echo '' || echo ', with uncommitted changes'))"
(cd "$app" && npm run --silent companion-shell:sync -- "${platforms[@]}" >"$cache/sync.log" 2>&1) || {
  tail -40 "$cache/sync.log"
  exit 1
}

if [ ${#android[@]} -gt 0 ]; then
  echo "→ gradle assembleDebug"
  java_home=${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}
  if (cd "$shell/android" && JAVA_HOME="$java_home" ./gradlew -q :app:assembleDebug >"$android_work/build.log" 2>&1); then
    apk=$shell/android/app/build/outputs/apk/debug/app-debug.apk
    for serial in "${android[@]}"; do
      echo "→ install on $serial"
      if out=$("$adb" -s "$serial" install -r "$apk" 2>&1); then
        installed+=("android $serial")
        [ -z "$launch" ] || "$adb" -s "$serial" shell am start -n "$app_id/.MainActivity" >/dev/null 2>&1 \
          || echo "  installed, but did not launch: unlock the phone" >&2
      else
        case "$out" in
          *INSTALL_FAILED_UPDATE_INCOMPATIBLE*)
            echo "  a store build is on $serial: its signature is not this one's. Uninstalling it deletes the Device's keys -- do that by hand if you mean it" >&2 ;;
          *) printf '%s\n' "$out" | tail -5 >&2 ;;
        esac
        failed+=("android $serial")
      fi
    done
  else
    tail -30 "$android_work/build.log" >&2
    for serial in "${android[@]}"; do failed+=("android $serial (build)"); done
  fi
fi

# One xcodebuild per iPhone, into one derived-data folder: with the device
# as the destination, -allowProvisioningUpdates registers it on the team's
# profile, which a generic build would not; every build after the first
# only re-signs. (The `+` spelling: macOS's bash 3.2 calls an empty array
# unbound.)
for udid in ${ios[@]+"${ios[@]}"}; do
  echo "→ xcodebuild for $udid"
  if (cd "$shell/ios/App" && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
    -destination "id=$udid" -derivedDataPath "$ios_work/dd" -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$team" build >"$ios_work/build.log" 2>&1); then
    echo "→ install on $udid"
    if xcrun devicectl device install app --device "$udid" "$ios_work/dd/Build/Products/Debug-iphoneos/App.app" >"$ios_work/install.log" 2>&1; then
      installed+=("ios $udid")
      printf '%s\n' "$team" >"$remembered"
      [ -z "$launch" ] || xcrun devicectl device process launch --device "$udid" --terminate-existing "$app_id" >/dev/null 2>&1 \
        || echo "  installed, but did not launch: unlock the phone" >&2
    else
      grep -iE "error|reason" "$ios_work/install.log" | head -5 >&2 || tail -5 "$ios_work/install.log" >&2
      failed+=("ios $udid")
    fi
  else
    grep -E "error:" "$ios_work/build.log" | sort -u | head -10 >&2 || tail -20 "$ios_work/build.log" >&2
    failed+=("ios $udid (build)")
  fi
done

echo
[ ${#installed[@]} -eq 0 ] || printf 'installed  %s\n' "${installed[@]}"
[ ${#failed[@]} -eq 0 ] || { printf 'FAILED     %s\n' "${failed[@]}" >&2; exit 1; }
