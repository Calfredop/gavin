---
order: 24576
kind: task
title: "[sec] The Companion leaves the last Workstation frame in the iOS app switcher and Android Recents after the Unlock ends"
status: Done
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe, on a Simulator, emulator or phone, which frame the OS keeps as the app-switcher or Recents snapshot once the Unlock has ended. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `companion-shell:os-task-snapshot-retains-workstation-view-after-unlock-ends`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

ADR 0004 (lines 8 and 18) says the Unlock, and with it the Workstation, ends when the Companion goes to the background or the phone locks. leaveOnLock.ts and the hub's leave-on-lock effect then close the bundle so its last cards, sessions and file names stop showing. Neither platform hides what is drawn before the OS takes its task snapshot, and every lifecycle reaction waits for the Unlock's delayed background decision: 2 s on iOS (briefBackground), 700 ms on Android (SETTLE_MS). The OS takes the snapshot when the app leaves the screen, before either delay runs out.

On iOS, didEnterBackground only starts a background task and a timer. AppDelegate's resign and background callbacks are empty template stubs, SceneDelegate has no resign or background callback, and BundleViewController puts the bundle over the hub as a child view with no cover view and no isHidden toggle. The only willResignActive or willDeactivate observer is the debug lifecycle trace, which only logs. On Android, BundleActivity.onStop only sends STOPPED. Nothing under android/app/src/main sets FLAG_SECURE or calls setRecentsScreenshotEnabled(false), and the manifest sets no excludeFromRecents. The web layers hide nothing on visibilitychange or pagehide either; the bundle's only visibilitychange listener resyncs the text size.

The likely result: someone who picks up the owner's unlocked phone after the owner left the Companion (Home or an app switch) with a Workstation open opens the app switcher or Recents and reads the last terminal, card or file frame, or the unlocked hub's attention inbox, with no Face ID, fingerprint or passcode. Tapping the card brings back the locked hub, so this is disclosure of one frame, not regained control. Within the grace period the holder already has full control, which ADR 0004 accepts; the delta is the frame that outlives it. No document under docs/security, docs/adr, docs/research or the shell README accepts the OS snapshot.

## Root cause

The Companion ties every reaction to leaving the screen to the Unlock's delayed background decision. Nothing hides the Workstation content at the screen level, immediately, on resign-active, background or onStop, and neither platform opts out of the OS task snapshot.

## The invariant to enforce

When the Companion leaves the foreground, the frame the OS keeps for the app switcher or Recents never shows Workstation content (a bundle, or the unlocked hub's Workstation data). This is decided synchronously when the app leaves the screen, independent of the Unlock's grace period, and the cover comes off when the app is active again.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/companion-shell/ios/App/App/DeviceKeysPlugin.swift:205` (didEnterBackground): Registered at 140-141. Begins a background task and schedules endForBackground after briefBackground (line 193, 2 s, line 217). Nothing is covered or hidden.
- `app/companion-shell/ios/App/App/DeviceKeysPlugin.swift:221` (endForBackground): Only here does the Unlock end (hold(nil), line 226) and the web layer hear 'background'.
- `app/companion-shell/ios/App/App/DeviceKeysPlugin.swift:270` (lifecycle trace): Lists willResignActiveNotification (270) and UIScene.willDeactivateNotification (276); its observer only logs.
- `app/companion-shell/ios/App/App/AppDelegate.swift:26` (applicationWillResignActive) and `:31` (applicationDidEnterBackground): Empty template stubs.
- `app/companion-shell/ios/App/App/SceneDelegate.swift:7` (scene willConnectTo): The delegate implements only willConnectTo, openURLContexts (17) and continue userActivity (21); there is no sceneWillResignActive or sceneDidEnterBackground.
- `app/companion-shell/ios/App/App/BundleViewController.swift:123` (present(over:)): The bundle webview is a full-window child view over the hub. It leaves only through dismiss (135), which runs after the web layer closes the visit.
- `app/companion-shell/android/app/src/main/java/com/gavin/companion/BundleActivity.java:309` (onStop): Sends STOPPED only. The activity is started without task flags (BundleViewPlugin.java:50-55), so it sits on MainActivity's singleTask task.
- `app/companion-shell/android/app/src/main/java/com/gavin/companion/AppForeground.java:66` (update) / `:86` (settle): The background decision is posted with SETTLE_MS = 700 ms (line 31, postDelayed at 80) and delivered to DeviceKeysPlugin.java:152, which ends the Unlock.
- `app/companion-shell/android/app/src/main/java/com/gavin/companion/MainActivity.java:20` (onCreate): Registers plugins and the text size only; no FLAG_SECURE, no setRecentsScreenshotEnabled. A grep of android/app/src/main for FLAG_SECURE, setRecentsScreenshotEnabled and excludeFromRecents finds nothing.
- `app/companion-shell/src/routes/+page.svelte` (leave-on-lock effect): leavesVisitOnLock drives visits.close() only after the delayed lifecycle event, by which time the OS already holds its image.

## What the audit could not observe

- iOS: whether the app-switcher snapshot is taken as the scene enters the background (before the 2 s timer fires), and whether it is never replaced after BundleViewController is dismissed in the background under the granted background task.
- iOS: whether the on-disk snapshot in the app's data container (Library/SplashBoard/Snapshots or Library/Caches/Snapshots) still holds the Workstation frame after the Unlock ended.
- Android: whether the task snapshot captured when BundleActivity stops stays as the Recents thumbnail after BundleActivity.finish() runs about 700 ms later in the background, and on which API levels (minSdk is 30).

## Fix

iOS: cover the window synchronously on sceneWillResignActive (or UIScene.willDeactivateNotification), independent of briefBackground, and remove the cover on sceneDidBecomeActive. The cover is an opaque view over the whole window (the hub and any presented bundle), plain or with the app's mark, never a blur of the content under it. Resign-active also fires for Control Center, the notification shade and the app switcher itself; covering there is correct and costs nothing. Leave the Unlock's own 2 s rule alone.

Android: call setRecentsScreenshotEnabled(false) in MainActivity and BundleActivity on API 33+. Below 33 (minSdk is 30) the only opt-out is FLAG_SECURE, which also blocks the owner's screenshots and screen recordings, and with them `scripts/device-drive.sh` captures and the README's real Companion captures. Decide that trade-off in the card's Comments: FLAG_SECURE on API 30-32 only, or a cover drawn in onPause on those levels, and note which.

Regression check, written first and run on a Simulator addressed by its own UDID (never `booted`) and an emulator addressed by serial. No suite reaches the OS task snapshot, so this is a script, `app/companion-shell/scripts/snapshot.sh ios <udid> | android <serial>`, beside probe.sh and keys.sh:

- Pair with an isolated Workstation (a debug daemon under a temp $HOME, `scripts/pair.sh`) and open a terminal that prints a dummy marker such as SNAPSHOT-MARKER.
- Android: `adb -s <serial> shell input keyevent KEYCODE_HOME`, wait 5 s, `input keyevent KEYCODE_APP_SWITCH`, then `adb -s <serial> exec-out screencap -p`. The check fails if the Companion card shows the marker.
- iOS: bring another app forward with `xcrun simctl launch <udid> com.apple.Preferences`, wait 5 s, then list the newest file under the Companion's data container (`xcrun simctl get_app_container <udid> com.gavin.companion data`) in Library/SplashBoard/Snapshots and Library/Caches/Snapshots. Convert it to PNG if a local tool reads its format. The check fails if it shows the marker. If no local tool reads the snapshot, say so in the card and leave the iOS verdict to the human test.
- Repeat once from the unlocked hub with an attention-inbox entry visible. Dummy content only.

The script fails before the change and passes after it on both platforms.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are a script in the touched module (`scripts/snapshot.sh`), and they fail before the change.
- The regression test fails before the change and passes after it.
- The checks in CLAUDE.md pass for every part you touched.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On a physical iPhone and an Android phone paired to a Workstation showing dummy terminal text, open a terminal in the Companion, press Home, wait more than 3 s, open the app switcher or Recents, and check that the Companion's card shows no terminal text and that tapping it brings back the locked hub."

## Comments

### 2026-10-16

**Confirmed.** Before the fix, an iOS Simulator SplashBoard `.ktx` (converted with `sips`) still held `SNAPSHOT-MARKER` from the unlocked hub after Preferences was brought forward and the Unlock's 2 s grace had ended. After the opaque window cover on `sceneWillResignActive`, the same check passes: the `.ktx` no longer contains the marker.

**Android API 30–32 trade-off:** opaque cover in `onPause` / remove in `onResume`, not `FLAG_SECURE`. `FLAG_SECURE` would also block the owner's screenshots and `scripts/device-drive.sh` / README captures. API 33+ uses `setRecentsScreenshotEnabled(false)` on `MainActivity` and `BundleActivity`.

**Android observation:** Play-store AVDs return a solid black frame from `screencap` of Recents (with or without the fix), so OCR of that capture is not a valid gate. `scripts/snapshot.sh` refuses to treat a blank Recents capture as a pass; it tries on-disk task bitmaps when `adb root` works (google_apis/userdebug). Physical-device Recents is the human test below. The script's iOS SplashBoard path is the automated OS-snapshot proof.

**Regression:** `app/companion-shell/scripts/snapshot.sh` (desk mode in `devstack.mjs snapshot`). Fingerprint: `companion-shell:os-task-snapshot-retains-workstation-view-after-unlock-ends`.

- [ ] Human test: On a physical iPhone and an Android phone paired to a Workstation showing dummy terminal text, open a terminal in the Companion, press Home, wait more than 3 s, open the app switcher or Recents, and check that the Companion's card shows no terminal text and that tapping it brings back the locked hub.
