# Sourced by probe.sh and keys.sh: build a DEBUG app and put it on the
# Simulator or emulator named. Not a script of its own.
#
#   build_and_install <platform> <target> <work-dir> [sync args...]
#
# Syncs both web builds into the native project (passing the sync args
# on, e.g. --probe), builds, and installs. Sets `adb` for Android.
# Name devices by UDID or serial, never `booted`: other sessions on this
# Mac boot simulators of their own.

app_id=com.gavin.companion

build_and_install() {
  platform=$1
  target=$2
  work=$3
  shift 3
  (cd "$shell/.." && npm run --silent companion-shell:sync -- "$platform" "$@" >"$work/sync.log" 2>&1) || {
    cat "$work/sync.log"
    exit 1
  }
  case "$platform" in
    ios)
      (cd "$shell/ios/App" && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
        -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$work/dd" build \
        CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= >"$work/build.log" 2>&1) || {
        grep -E "error:" "$work/build.log" || tail -20 "$work/build.log"
        exit 1
      }
      xcrun simctl install "$target" "$work/dd/Build/Products/Debug-iphonesimulator/App.app"
      ;;
    android)
      java_home=${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}
      (cd "$shell/android" && JAVA_HOME="$java_home" ./gradlew -q :app:assembleDebug >"$work/build.log" 2>&1) || {
        tail -30 "$work/build.log"
        exit 1
      }
      adb=${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb
      "$adb" -s "$target" install -r "$shell/android/app/build/outputs/apk/debug/app-debug.apk" >/dev/null
      ;;
    *)
      echo "unknown platform: $platform (ios or android)" >&2
      exit 2
      ;;
  esac
}
