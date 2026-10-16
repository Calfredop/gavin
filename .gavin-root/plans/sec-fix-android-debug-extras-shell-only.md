---
kind: task
title: "[sec] A debuggable Android Companion honours gavinKeysCheck and gavinPairCode from any app that starts its exported MainActivity, so any app can wipe the Device's keys and every pairing"
status: To Do
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe, on an emulator or phone, that a third-party app's startActivity creates a new MainActivity whose onCreate reads the caller's extras. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `companion-shell/android/MainActivity.onCreate:debug-intent-extras-honoured-from-any-caller`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

MainActivity is the exported MAIN/LAUNCHER activity (exported="true", launchMode singleTask). In a debuggable build its onCreate copies four script-only extras from getIntent(): gavinPairCode, gavinBundleProbe, gavinKeysCheck and gavinStrictKeys. The only gate is FLAG_DEBUGGABLE. Nothing checks who launched it; there is no getLaunchedFromUid, getCallingPackage or getReferrer anywhere under android/app/src/main/java. The intended caller is the developer's adb shell (keys.sh, pair.sh, probe.sh and hub.sh run `am start -S -n … --ez/--es …`).

With gavinKeysCheck set, DeviceKeys.status() answers checkRequested, and the hub calls runKeysCheck with no owner confirmation. Once readiness passes, runKeysCheck calls keys.deleteKeys() before any prompting call. On Android that runs deleteAll: it deletes the HARDWARE_ALIAS and NOISE_WRAP_ALIAS keystore entries and the Noise key file, and WorkstationsPlugin.deleteAll removes every paired Workstation record. The phone must pair again with every Workstation. The same unguarded path lets another app start a scripted pairing with a code it chooses (gavinPairCode reaches QrScanner.scriptedCode() and then pairing.startWith), without the Unlock; the hardware-key prompt and the desk's SAS confirmation still stand in the way of that variant.

A release build is not debuggable, so every seam is off there. But debug builds reach real phones: `scripts/usb-install.sh` (now committed, documented in the shell README) runs :app:assembleDebug and installs the APK with `adb install -r` on every USB-attached Android phone, under the same applicationId com.gavin.companion. A cold start is not needed: under standard Android semantics a caller passing FLAG_ACTIVITY_NEW_TASK|FLAG_ACTIVITY_CLEAR_TASK gets a new instance whose onCreate sees its Intent. iOS is not affected: its equivalents are launch arguments read under #if DEBUG, which another app cannot set.

## Root cause

The debug seam is gated on what kind of build is running (FLAG_DEBUGGABLE), not on who sent the request. The requests arrive as extras on the exported launcher activity, which any co-installed app may start, so a seam meant for the developer's adb session also answers other apps. The keys check it triggers deletes the keys before its first prompt.

## The invariant to enforce

A script-only debug request (keys check, strict keys, bundle probe, scripted pairing code) is honoured only when it comes from the developer's adb shell, through a channel no other app on the phone can write. Nothing another app can put in an Intent starts one.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/companion-shell/android/app/src/main/AndroidManifest.xml:24` (activity .MainActivity): exported="true", launchMode singleTask (23), MAIN/LAUNCHER filter (26-29). Any app may startActivity on it with arbitrary extras.
- `app/companion-shell/android/app/src/main/java/com/gavin/companion/MainActivity.java:28` (onCreate): `debuggable` is the only gate. Lines 29-32 copy gavinPairCode into QrScannerPlugin.scripted, gavinBundleProbe into BundleViewPlugin.probeRequested, gavinKeysCheck into DeviceKeysPlugin.checkRequested and gavinStrictKeys into DeviceKeysPlugin.strict. There is no onNewIntent override.
- `app/companion-shell/android/app/src/main/java/com/gavin/companion/DeviceKeysPlugin.java:208` (status): Answers checkRequested = debuggable() && checkRequested.
- `app/companion-shell/src/routes/+page.svelte:321` (onMount): `if (status.checkRequested) return runKeysCheck(…)`, with no owner confirmation. Lines 322-327: a scripted code reaches pairing.startWith(text) without the Unlock.
- `app/companion-shell/src/shell/keys/keysCheck.ts:117` (runKeysCheck): keys.deleteKeys() runs unconditionally once readiness passes, before createKeys (119) and before the first sign() prompt (167). The header (13-14) says a paired phone must pair again afterwards.
- `app/companion-shell/android/app/src/main/java/com/gavin/companion/DeviceKeysPlugin.java:328` (deleteKeys) → `:338` (deleteAll): Deletes both keystore aliases (341), the Noise key file, and every Workstation record (WorkstationsPlugin.deleteAll, 348).
- Script callers that must keep working: `scripts/keys.sh:72-73`, `scripts/pair.sh:116-138`, `scripts/probe.sh:44`, `scripts/hub.sh:102-115` and `:152`.

## What the audit could not observe

- That a third-party foreground app's startActivity (with FLAG_ACTIVITY_NEW_TASK|FLAG_ACTIVITY_CLEAR_TASK, or a cold start after killBackgroundProcesses or a task removal) creates a new MainActivity whose onCreate reads the caller's extras intact, on the Android versions in use. No emulator or adb was allowed in the audit.
- How often an owner keeps a usb-install.sh debug build as their working Device.

## Fix

Stop reading the four extras from the Intent. Move the triggers into files in the app's private storage, which only the app itself and `adb shell run-as com.gavin.companion` can write (run-as works only for a debuggable app, and only from the shell or root):

- A small class, e.g. `DebugLaunch`, reads and deletes `files/gavin-debug/{keys-check,strict-keys,bundle-probe,pair-code}` once, in MainActivity.onCreate, and only when the build is debuggable. pair-code holds the base64 code. A request is consumed when read, so a later launch by anyone sees nothing.
- keys.sh, pair.sh, probe.sh and hub.sh write the file with `adb -s <serial> shell run-as com.gavin.companion sh -c '…'` before their `am start -S`, and stop passing `--ez`/`--es`.

Rejected: Activity.getLaunchedFromUid() == Process.SHELL_UID. It exists only on API 34+ (minSdk is 30), and whether `am start` from the shell reports the shell uid there would itself have to be measured.

Optional hardening, in the same change if it stays small: runKeysCheck refuses to delete when status reports existing keys or any pairing exists, unless the request file says so explicitly (keys.sh can write that), with a case in keysCheck.test.ts.

Regression tests, written first:

- In `src/shell/keys/deviceKeys.test.ts` (it already reads the native sources by path, line 107), or a new test beside it: MainActivity.java contains no `getIntent().get…Extra("gavin` call. It fails today on lines 29-32.
- A JVM unit test in `android/app/src/test/java/com/gavin/companion/DebugLaunchTest.java` (junit is already a testImplementation in android/app/build.gradle): with debuggable false, request files are ignored; with debuggable true, each request is read once and its file is gone afterwards; with no files, nothing is requested.
- On a throwaway emulator addressed by serial, never a real Device: `scripts/keys.sh android <serial>` and `scripts/pair.sh android` still work end to end.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The regression test fails before the change and passes after it.
- The checks in CLAUDE.md pass for every part you touched.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On a throwaway emulator with a debuggable Companion paired to an isolated Workstation, start MainActivity from a second test app with FLAG_ACTIVITY_NEW_TASK|FLAG_ACTIVITY_CLEAR_TASK and the extra gavinKeysCheck=true, and check that the Companion keeps its keys and still lists the paired Workstation, while scripts/keys.sh against the same emulator still runs the keys check."
