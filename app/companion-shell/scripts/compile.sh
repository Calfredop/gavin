#!/usr/bin/env bash
# Sync the Companion shell into the native projects and compile.
#
#   scripts/compile.sh ios [--release] [--install <udid>] [--team <TEAM_ID>] [--build-number N]
#   scripts/compile.sh android [--release] [--install <serial>] [--build-number N]
#   scripts/compile.sh both [--release] [--build-number N]
#
# Prerequisites and store upload: docs/companion-mobile.md.
# Name devices by UDID or serial, never `booted`.

set -euo pipefail

shell="$(cd "$(dirname "$0")/.." && pwd)"
app="$(cd "$shell/.." && pwd)"
work="${TMPDIR:-/tmp}/gavin-companion-compile-$$"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

usage() {
  cat <<EOF
Usage:
  $(basename "$0") ios|android|both [--release] [--probe]
                   [--install <udid-or-serial>] [--team <APPLE_TEAM_ID>]
                   [--build-number N] [--out <dir>]

  --release        store-shaped sync (no dev key, no probe) and Release / bundleRelease
  --probe          embed the probe bundle (debug sync only; ignored with --release)
  --install TARGET install a debug build on that Simulator / emulator / device
  --team ID        DEVELOPMENT_TEAM for an iOS archive build
  --build-number N CURRENT_PROJECT_VERSION / versionCodeOverride (default 1)
  --out DIR        where to put the archive / AAB / APK artefacts
EOF
  exit 2
}

platform="${1:-}"
[[ -n "$platform" ]] || usage
shift

release=0
probe=0
install_target=""
team="${DEVELOPMENT_TEAM:-}"
build_number=1
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release=1; shift ;;
    --probe) probe=1; shift ;;
    --install) install_target="$2"; shift 2 ;;
    --team) team="$2"; shift 2 ;;
    --build-number) build_number="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) usage ;;
  esac
done

case "$platform" in
  ios|android|both) ;;
  *) usage ;;
esac

if [[ "$release" -eq 1 && -n "$install_target" ]]; then
  echo "compile.sh: --install is for debug builds; use store-submit.sh for release upload" >&2
  exit 1
fi
if [[ "$platform" == both && -n "$install_target" ]]; then
  echo "compile.sh: --install needs a single platform (ios or android)" >&2
  exit 1
fi
if [[ "$release" -eq 1 && "$probe" -eq 1 ]]; then
  echo "compile.sh: --probe is ignored with --release (probe is debug-only)" >&2
  probe=0
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "compile.sh: missing prerequisite: $1" >&2
    exit 1
  fi
}

need npm
need cargo
if [[ "$platform" == ios || "$platform" == both ]]; then
  need xcodebuild
fi
if [[ "$platform" == android || "$platform" == both ]]; then
  need java
fi

if ! rustup target list --installed 2>/dev/null | grep -qx 'wasm32-unknown-unknown'; then
  echo "compile.sh: adding rustup target wasm32-unknown-unknown"
  rustup target add wasm32-unknown-unknown
fi

sync_args=()
[[ "$platform" == both ]] || sync_args+=("$platform")
[[ "$release" -eq 1 ]] && sync_args+=(--release)
[[ "$probe" -eq 1 ]] && sync_args+=(--probe)

echo "→ npm ci (companion-shell) if needed"
if [[ ! -d "$shell/node_modules/@capacitor/cli" ]]; then
  (cd "$shell" && npm ci)
fi
if [[ ! -d "$app/node_modules" ]]; then
  (cd "$app" && npm ci)
fi

# --install reuses device.sh, which syncs itself with the same flags.
if [[ -n "$install_target" ]]; then
  # shellcheck disable=SC1091
  source "$shell/scripts/device.sh"
  install_sync=()
  [[ "$probe" -eq 1 ]] && install_sync+=(--probe)
  build_and_install "$platform" "$install_target" "$work" "${install_sync[@]}"
  printf 'installed %s debug build on %s\n' "$platform" "$install_target"
  exit 0
fi

echo "→ companion-shell:sync ${sync_args[*]:-}"
(cd "$app" && npm run companion-shell:sync -- "${sync_args[@]}")

java_home="${JAVA_HOME:-}"
if [[ -z "$java_home" && -x /usr/libexec/java_home ]]; then
  java_home="$(/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home)"
fi

compile_ios() {
  if [[ "$release" -eq 1 ]]; then
    [[ -n "$team" ]] || {
      echo "compile.sh: iOS --release needs --team <APPLE_TEAM_ID> (or DEVELOPMENT_TEAM)" >&2
      exit 1
    }
    dest="${out:-$shell/build-out}"
    mkdir -p "$dest"
    archive="$dest/App.xcarchive"
    echo "→ xcodebuild archive → $archive"
    (cd "$shell/ios/App" && xcodebuild -project App.xcodeproj -scheme App \
      -configuration Release -destination 'generic/platform=iOS' \
      -archivePath "$archive" -allowProvisioningUpdates \
      DEVELOPMENT_TEAM="$team" CURRENT_PROJECT_VERSION="$build_number" archive)
    printf 'iOS archive: %s\n' "$archive"
  else
    echo "→ xcodebuild (Simulator, Debug)"
    (cd "$shell/ios/App" && xcodebuild -project App.xcodeproj -scheme App \
      -configuration Debug -sdk iphonesimulator \
      -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$work/dd" build \
      CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=)
    app_path="$work/dd/Build/Products/Debug-iphonesimulator/App.app"
    dest="${out:-$shell/build-out}"
    mkdir -p "$dest"
    rm -rf "$dest/App.app"
    cp -R "$app_path" "$dest/App.app"
    printf 'iOS Simulator app: %s/App.app\n' "$dest"
  fi
}

compile_android() {
  export JAVA_HOME="${java_home:-${JAVA_HOME:-}}"
  if [[ "$release" -eq 1 ]]; then
    echo "→ gradlew bundleRelease -PversionCodeOverride=$build_number"
    (cd "$shell/android" && ./gradlew bundleRelease -PversionCodeOverride="$build_number")
    aab="$shell/android/app/build/outputs/bundle/release/app-release.aab"
    dest="${out:-$shell/build-out}"
    mkdir -p "$dest"
    cp "$aab" "$dest/app-release.aab"
    printf 'Android AAB: %s/app-release.aab\n' "$dest"
    if [[ ! -f "$shell/android/keystore.properties" \
       && -z "${GAVIN_ANDROID_UPLOAD_KEYSTORE:-}" ]]; then
      echo "compile.sh: warning: no upload keystore — AAB is unsigned; Play will refuse it" >&2
    fi
  else
    echo "→ gradlew :app:assembleDebug"
    (cd "$shell/android" && ./gradlew :app:assembleDebug)
    apk="$shell/android/app/build/outputs/apk/debug/app-debug.apk"
    dest="${out:-$shell/build-out}"
    mkdir -p "$dest"
    cp "$apk" "$dest/app-debug.apk"
    printf 'Android APK: %s/app-debug.apk\n' "$dest"
  fi
}

case "$platform" in
  ios) compile_ios ;;
  android) compile_android ;;
  both)
    compile_ios
    compile_android
    ;;
esac
