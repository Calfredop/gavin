# Device keys and the Unlock on real phones

Spiked 2026-09-28 for Companion 02 with a throwaway app: a bare Capacitor 8.5.2 shell plus one app-local plugin in Swift and one in Kotlin. The app is kept out of git, under `.spike/device-keys/` in the spike's worktree. It ran on:

- **Xcode 27.0**, iOS 27.0 and 26.5 Simulators, on an Apple-silicon Mac.
- **Android Emulator**, an API 36 `google_apis_playstore` arm64 image with KeyMint 400 and WebView 133.

Each statement is tagged:

- **Measured:** observed in the spike.
- **Documented:** platform documentation, not reproduced here.
- **Device test:** waits on the owner's iPhone and Android phone. The human test filed on the card covers it.

Read this beside the spec (`docs/superpowers/specs/2026-09-27-companion-design.md`), `CONTEXT.md`, and ADRs 0001, 0004 and 0005. It amends all three ADRs; see the last section.

## Summary

1. **One authentication, many signatures: yes on both platforms, but the hardware does not know about "foreground".**
   - **iOS:** the Secure Enclave key signs silently for as long as the shell holds the `LAContext` that was evaluated at the Unlock.
   - **Android:** a key bound to an authentication window of T seconds signs silently for T seconds after *any* user authentication on the phone, including simply unlocking the lock screen (**measured**).
   - **The shell** ends the Unlock on background and on lock. The phone's hardware additionally refuses while the phone is locked (Android: **measured**; iOS: **device test**), and on Android after T.
   - **Brief interruptions:** Control Center, the notification shade, the call banner and the Unlock's own prompt never reach "background". On Android that is **measured**; on iOS the Face ID sheet is **measured** and the rest is a **device test**.
2. **Emulated hardware: not usable for the Unlock.**
   - The iOS Simulator reports `SecureEnclave.isAvailable == true` and creates SE keys without access control, but refuses every SE key that requires user presence (`-25293`). It also does not enforce a keychain `.userPresence` ACL.
   - The Android emulator has no StrongBox, and its "hardware" keystore is software (`SECURITY_LEVEL_SOFTWARE`, software attestation root).
   - The planned fallback is confirmed: debug builds use a software key marked `software-debug`, and only a dev daemon accepts it.
3. **The Noise key is exportable by necessity**, because the WASM core does the X25519 DH itself.
   - **iOS:** a generic-password item, `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, not synchronizable.
   - **Android:** 32 random bytes sealed by a Keystore AES-256-GCM key (`setUnlockedDeviceRequired(true)`), kept in `noBackupFilesDir`, with backup and device transfer excluded.
   - **iOS keychain items survive an uninstall (measured)**, so the shell must wipe them on first launch or a reinstall would not be a new Device.
4. **Keys out of bundles: yes, a shell-only plugin works (measured on both).** A separately created webview has no Capacitor bridge. Three constraints go with it:
   - **Never an iframe in the shell's webview.** Capacitor iOS's `bridge` handler answers every frame, and a cross-origin iframe invoked the plugin natively (**measured**).
   - **The channel checks frame and origin natively.** On iOS the handler object is visible to subframes (**measured**).
   - **On Android, the bundle webview goes in its own app process.** Otherwise it shares one renderer process with the shell's webview, which holds the Noise key and every live connection (**measured**).
5. **A trap for the shell:** Capacitor 8.5.2 hangs on a blank page on the iOS 27.0 Simulator. Its bridge makes a synchronous `prompt()` that WebKit never delivers. iOS 26.5 is fine. A four-line document-start shim fixes it (see "Other traps").

## Recommended parameters

### iOS

```swift
// Hardware key: Secure Enclave P-256, one per install.
let acl = SecAccessControlCreateWithFlags(nil,
    kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,   // gone if the passcode is removed; never backed up
    [.privateKeyUsage, .userPresence],                 // biometry, falling back to the passcode
    &error)
SecKeyCreateRandomKey([
    kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256,
    kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs: [kSecAttrIsPermanent: true, kSecAttrApplicationTag: tag, kSecAttrAccessControl: acl],
] as CFDictionary, &error)

// The Unlock: ONE context per foreground stretch.
let ctx = LAContext()
ctx.evaluateAccessControl(acl, operation: .useKeySign, localizedReason: "Unlock the Companion") { ok, _ in
    ctx.interactionNotAllowed = true   // from now on: sign silently or fail, never a surprise prompt
}
// Every sign (every connection, every Workstation) looks the key up THROUGH that context:
SecItemCopyMatching([kSecClass: kSecClassKey, kSecAttrApplicationTag: tag, kSecReturnRef: true,
                     kSecUseAuthenticationContext: ctx] as CFDictionary, &item)
SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, handshakeHash, &error)

// End of the Unlock: ctx.invalidate() on UIApplication.didEnterBackgroundNotification
// and on protectedDataWillBecomeUnavailableNotification. Never on willResignActive.

// Noise key: 32 bytes, generic password, no ACL.
[kSecClass: kSecClassGenericPassword, kSecAttrAccessible: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
 kSecAttrSynchronizable: false, ...]
```

- **`.userPresence`, not `.biometryCurrentSet`.** ADR 0004 accepts the passcode as a fallback, and `.biometryCurrentSet` would silently destroy the Device every time a face or fingerprint is enrolled.
- **`WhenPasscodeSetThisDeviceOnly` on both keys** matches "pairing is refused without a passcode". Removing the passcode deletes both, so the Device must pair again (**Documented**).
- **First launch wipes the keychain.** A `UserDefaults` marker (which an uninstall does remove) gates a `SecItemDelete` of every item the Companion owns. Without it, a reinstall silently reuses the old Device's keys (**measured**: items survived an uninstall and reinstall on the Simulator).
- **`NSFaceIDUsageDescription`** must be in `Info.plist`.

### Android (minSdk 30)

```kotlin
// Hardware key: StrongBox when present, else TEE. One per install.
KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
    .setDigests(KeyProperties.DIGEST_SHA256)
    .setUserAuthenticationRequired(true)
    .setUserAuthenticationParameters(T,   // the auth window, see below
        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
    .setUnlockedDeviceRequired(true)      // no signature while the phone is locked
    .setIsStrongBoxBacked(true)           // on StrongBoxUnavailableException: rebuild with false
    .setAttestationChallenge(pairingNonce)
    .build()

// The Unlock: one BiometricPrompt, no CryptoObject.
BiometricPrompt.Builder(activity)
    .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
    .build().authenticate(CancellationSignal(), executor, callback)

// End of the Unlock (shell): ProcessLifecycleOwner ON_STOP and ACTION_SCREEN_OFF.
// Never onPause or window-focus loss.

// Noise key: 32 random bytes sealed with a Keystore AES-256-GCM key
// (PURPOSE_ENCRYPT|DECRYPT, no user auth, setUnlockedDeviceRequired(true)),
// iv+ciphertext in noBackupFilesDir. Manifest: allowBackup="false",
// fullBackupContent="false", dataExtractionRules excluding every domain for
// BOTH <cloud-backup> and <device-transfer>.
```

- **T = 3600 s (recommended; the owner decides, as a Decision on the card).**
  - **It opens with any authentication.** The window starts at the in-app prompt *or* at any lock-screen unlock with the device credential, and it ends after T whether or not the app is in front (**measured** with T = 30 s).
  - **So T is the one place Android differs from ADR 0004.** A *new* connection (a reconnect, or a Workstation not yet connected) opened more than T after the Unlock asks again. Live connections are unaffected.
  - **Why an hour.** It covers nearly every foreground stretch. Shortening it barely strengthens anything: the lock screen reopens the window anyway, and the shell already re-prompts on every return to the foreground.
- **Pairing verifies attestation.**
  - **What it checks:** the attestation chain from `getCertificateChain(alias)` goes in the pairing payload. The daemon checks it against Google's hardware attestation roots, and reads `attestationSecurityLevel` / `keymintSecurityLevel`, which must be TEE or StrongBox. It also checks the authorization list (user auth, the timeout, unlocked-device-required) and the challenge.
  - **What it catches:** this is the only way the daemon can *know*, rather than trust the app, that a Device's key is hardware-bound. On the emulator the chain roots at "Droid Unregistered Device CA" and every level reads SOFTWARE (**measured**), which a release daemon must refuse.
  - **iOS has no equivalent for an arbitrary Secure Enclave key.** App Attest attests its own key, not ours (**Documented**), so there the daemon relies on the shell's claim.
- **Key invalidation (Documented).** Removing the secure lock screen permanently invalidates the key (`KeyPermanentlyInvalidatedException`), so the Device must pair again. A new biometric enrolment does not invalidate a key with T > 0; `isInvalidatedByBiometricEnrollment` read false (**measured**).
- **Do not trust `FEATURE_HARDWARE_KEYSTORE`.** It is `true` on the emulator, whose keys are software (**measured**). Read `KeyInfo.securityLevel` or the attestation instead.

## 1. Signing after one authentication

### iOS

- **Held-context reuse is the documented route.** A context passed as `kSecUseAuthenticationContext` that has already been evaluated authorises the item without further UI. `interactionNotAllowed = true` turns any missing authorisation into `errSecInteractionNotAllowed` instead of a prompt (**Documented**).
- **In the spike (Simulator, software key, keychain ACL):**
  - One Face ID Unlock, then 1 + 5 signatures with no prompt, 1–7 ms each (**measured**).
  - The Face ID sheet fires `willResignActive`/`didBecomeActive` (**measured**). This is why ending the Unlock on resign-active would loop.
  - Home, then back: `didEnterBackground` ended the Unlock and the next sign was refused by the shell (**measured**).
- **Not settled without a real Secure Enclave (device test):**
  - that the SE honours the held context for repeated signs with no hidden expiry. The test signs again after ten minutes in front.
  - that the SE refuses while the phone is locked even with the context still held. The test turns off the shell's own end-on-background, then uses "Sign in 15 s" and locks the phone.
  - that the context survives a background/foreground cycle when the shell does *not* invalidate it (the same toggle). If it does survive, the shell's `invalidate()` is the only thing that ends the Unlock on background.

### Android

**Measured** on the emulator. keystore2 enforces these rules for software keys as well, and the platform documents the same behaviour for TEE and StrongBox keys:

| Situation | Hardware (`initSign`/`sign`, the shell's Unlock ignored) | Shell |
|---|---|---|
| No authentication in the last T | `UserNotAuthenticatedException` | refuses |
| After one in-app prompt (PIN) | 6 signatures, no prompt, 2–193 ms (first includes key load) | signs |
| T (30 s) later, app still in front | `UserNotAuthenticatedException` | refuses: the key does |
| Phone locked | `InvalidKeyException: Keystore operation failed` (`setUnlockedDeviceRequired`) | Unlock already ended at `SCREEN_OFF` |
| Lock-screen PIN only, no in-app prompt | **signs** | refuses |
| Home and back, within T | signs | refuses: Unlock ended at `ON_STOP` |
| Auth-per-use key (T = 0) | one prompt **per signature** (2 signatures, 2 PIN prompts) | — |

- **The shell is what enforces "since the Companion last came to the foreground".** The hardware enforces "someone authenticated to this phone within T, and it is unlocked now".
- **An auth-per-use key cannot meet the requirement.** A prompt per connection is exactly what the Unlock exists to avoid.

### Brief interruptions

| Event | iOS | Android (API 36) | Unlock |
|---|---|---|---|
| The Unlock's own prompt | `willResignActive` (**measured**) | window focus lost, no `onPause` (**measured**) | kept; the shell also ignores lifecycle while its prompt is up |
| Control Center / quick settings | `willResignActive` (**measured** on an iPhone 16 Pro, iOS 27.0: no background) | window focus lost only (**measured**) | kept |
| Notification shade | `didEnterBackground` while it is down, then `willEnterForeground` (**measured** on an iPhone 16 Pro, iOS 27.0, 2026-10-08: about a second for a glance) | window focus lost only (**measured**) | kept: the iOS side believes a background only after 2 s (`briefBackground`) |
| Incoming-call banner | at most `willResignActive` (**device test**) | nothing at all; signing kept working during the call (**measured**) | kept |
| Answering the call, app switch, Home | `didEnterBackground` (**measured** for app switch) | `ON_STOP` (**measured** for Home) | **ends** |
| Lock | `didEnterBackground`, `protectedDataWillBecomeUnavailable` (**device test**) | `onStop`, `SCREEN_OFF`, `ON_STOP` (**measured**) | **ends** |

**Rule for the shell:**

- End the Unlock on:
  - **iOS:** `didEnterBackground` and `protectedDataWillBecomeUnavailable`.
  - **Android:** `ProcessLifecycleOwner` `ON_STOP` and `ACTION_SCREEN_OFF`.
- Never end it on resign-active, `onPause` or focus loss.
- **iOS:** never on a background over within 2 s either: that is the notification shade (found after this ticket, `companion-notification-shade-ends-the-unlock-on-ios`).
- Ignore lifecycle events while the shell's own prompt is on screen. Older Android versions show the device-credential screen as a separate activity, which stops ours.

### What ends it

| | iOS | Android |
|---|---|---|
| Shell (both) | `invalidate()` + drop connections on background / lock | forget the Unlock + drop connections on background / screen off |
| Hardware / OS | context invalidated or freed, app terminated (**Documented**); lock (**device test**); passcode removed deletes the key (**Documented**) | T elapsed, phone locked (**measured**); lock screen removed invalidates the key (**Documented**) |
| Does **not** end it | a new Face ID enrolment (with `.userPresence`) | a new biometric enrolment (T > 0) |

## 2. Emulated hardware

**iOS Simulator** (27.0 and 26.5, same results; **measured**):

- **`SecureEnclave.isAvailable == true`.** A CryptoKit `SecureEnclave.P256.Signing.PrivateKey()` signs and verifies. `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` and ACL `[.privateKeyUsage]` also works, under both protection classes, permanent or not.
- **Any SE key whose ACL requires user presence fails** with `-25293` "Failed to generate keypair". That covers `.userPresence` and `.biometryAny | .or | .devicePasscode`, with or without simulated Face ID enrolled.
- **A keychain item with a `.userPresence` ACL is not enforced.** It read back in a fresh process through an unevaluated context, with no prompt.
- **What does work:** `LAContext.evaluatePolicy` with simulated Face ID (`notifyutil -p com.apple.BiometricKit_Sim.pearl.match`). `WhenPasscodeSetThisDeviceOnly` items store, reading back as `akpu`.
- **An unsigned Simulator build** (`CODE_SIGNING_ALLOWED=NO`) gets `-34018` on every keychain call. Build with "Sign to Run Locally".

**Android emulator** (API 36; **measured**):

- **No StrongBox:** `FEATURE_STRONGBOX_KEYSTORE` is false, and `setIsStrongBoxBacked(true)` throws `StrongBoxUnavailableException`.
- **No TEE either:** keys report `SECURITY_LEVEL_SOFTWARE` and `authEnforcedBySecureHardware = false`. Attestation roots at "O=Google Test LLC, CN=Droid Unregistered Device CA", with both levels SOFTWARE. `FEATURE_HARDWARE_KEYSTORE` still reads true.
- **The semantics are real, though.** The auth window, the unlocked-device requirement and auth-per-use all behave as on hardware (table above), so the emulator is a faithful model of the Unlock, just not of the hardware.
- Only API 36 was tried.

**Fallback, confirmed:**

- **iOS debug builds** on the Simulator use a software P-256 key (CryptoKit, stored in the keychain) and still run the full `LAContext` Unlock flow. The flow is real; the gate is not.
- **Android debug builds** need no special key. The emulator's keystore key *is* the software key, and its attestation says so.
- **In both cases the pairing payload marks the key.** iOS carries `software-debug`; Android carries its attestation levels. A daemon built with `debug_assertions` accepts it, and a release daemon refuses it.

## 3. The Noise key

- **It has to leave the keystore on both platforms.**
  - **Why:** ADR 0002 puts the Noise handshake in the WASM Companion core, which needs the raw X25519 scalar to do the DH.
  - **Android's alternative was tried and rejected:** Android's Keystore can hold X25519 (`KeyPairGenerator("XDH", "AndroidKeyStore")` succeeded on API 36, **measured**), but the key is non-exportable. That would move the DH out of WASM into native code on Android only, against ADR 0001's "one code path".
  - **Why it's acceptable:** ADR 0001 already makes a copied Noise key worthless without the hardware signature.
- **iOS:**
  - A generic-password item with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, `kSecAttrSynchronizable = false` and no ACL, since the handshake runs before the signature, inside the same Unlock.
  - **ThisDeviceOnly** keeps it out of iCloud Keychain and off any other device's restore (**Documented**).
  - **Not in a shared access group.** The Notification Service Extension needs the per-Workstation *notification* keys, not the Noise key. Those need `AfterFirstUnlockThisDeviceOnly`, since pushes arrive on a locked phone, plus a shared access group. They are outside this spike.
- **Android:**
  - A Keystore AES-256-GCM key: `setUnlockedDeviceRequired(true)`, no user authentication, and no StrongBox (slow, and not needed for a wrapping key). It seals 32 random bytes stored in `noBackupFilesDir` (**measured**).
  - Backup is off in the manifest. `allowBackup="false"` alone does not stop device-to-device transfer for targetSdk 31 and above, so `dataExtractionRules` also excludes `<device-transfer>` (**Documented**).
  - A restored ciphertext would be undecryptable anyway, because Keystore keys never leave the device. The shell must treat "cannot decrypt" as "not a Device".
- **Reinstall:**
  - **Android** deletes Keystore keys and app files on uninstall, so a reinstall is a new Device for free (**Documented**).
  - **iOS keeps keychain items across an uninstall (measured).** Hence the first-launch wipe above.

## 4. Keeping keys out of bundles

**Measured, on the iOS 27.0 Simulator and the Android API 36 emulator:**

| Probe | iOS | Android |
|---|---|---|
| Separate webview: `window.Capacitor` / Capacitor bridge | `undefined` / `undefined` | `undefined` / `undefined` |
| Separate webview: shell channel | `gavinChannel` present | `gavinChannel` present |
| Cross-origin iframe inside the bundle calls the channel | handler **visible**; refused natively (`isMainFrame = false`) | not injected: `addWebMessageListener` origin rule |
| Bundle `fetch` to the shell origin / the internet | fails / fails | fails / fails |
| Bundle navigates to `https://example.com` | cancelled, stays on its origin | blocked, stays on its origin |
| Bundle origin | `gavin-bundle://ws-demo`, `isSecureContext` true, `crypto.subtle` present | `https://ws-demo.bundle.gavin.invalid` (intercepted), secure context |
| Cross-origin (`data:`) iframe **inside the shell's Capacitor webview** | sees `webkit.messageHandlers.bridge`; its `DeviceKeys.info` call **ran natively** | no `androidBridge` (origin-gated modern bridge) |
| Renderer process, shell vs bundle | separate WebContent processes | **one shared renderer**; a second appears only when the bundle's activity runs in `android:process=":bundle"` |

**So a shell-only plugin keeps keys out of bundles, on five conditions:**

1. **A bundle is never loaded inside the shell's Capacitor webview, not even in an iframe.** Capacitor iOS registers its `bridge` script-message handler for every frame and never looks at `frameInfo`, so any frame there can call every plugin. The shell page's CSP should say `frame-src 'none'`, and the shell never navigates to remote content. On Android the modern bridge is origin-gated, but its legacy fallback (`addJavascriptInterface`, used when `WEB_MESSAGE_LISTENER` is missing) is not.
2. **The channel checks natively.**
   - **iOS:** `WKScriptMessageHandlerWithReply` in the `.page` world, accepting only `frameInfo.isMainFrame` with the bundle's scheme and host.
   - **Android:** `WebViewCompat.addWebMessageListener(webView, name, setOf(origin))` plus an `isMainFrame` check.
   - No `addJavascriptInterface` anywhere.
3. **An app-local origin per Workstation.**
   - **iOS:** a `WKURLSchemeHandler` scheme, with the Workstation as the host, and its own (`nonPersistent` or per-identifier) data store.
   - **Android:** an intercepted `https://<workstation>.<reserved domain>` host.
   - Every other navigation and sub-resource is refused.
4. **On Android, the bundle activity runs in its own app process.**
   - **Why:** WebView gives each app process one renderer, and the shell's webview holds the Noise private key and every Workstation's live connection in its JavaScript heap.
   - **What goes wrong otherwise:** a compromised Workstation that finds a renderer exploit through data its bundle renders would land in that process. That is exactly what ADR 0005 exists to prevent.
   - **Two consequences:** the second process must call `WebView.setDataDirectorySuffix` before creating a webview (**measured**), and the channel then crosses processes (a bound service or Messenger).
5. **Only the shell's own web layer**, shipped in the binary, sees the Noise private key, handed over for the WASM core. The hardware key never leaves native code.

## Considered and rejected

- **An Android auth-per-use key (T = 0) with a `CryptoObject`.**
  - **For:** it is the only Android setup where the lock screen cannot stand in for the in-app prompt.
  - **Against:** it prompts once per signature, so every reconnect and every Workstation would prompt (**measured**).
- **Delegating to a per-Unlock session key.**
  - **The idea:** at each Unlock the hardware key certifies an in-memory key, and connections are signed with that.
  - **For:** it would allow T = 0 on Android and remove any reliance on held contexts.
  - **Against:**
    - the certified key lives in app memory, so code running in the app could copy it and connect *from anywhere* until the certificate expires. With the recommended design, a signature is only ever made on the phone.
    - it changes ADR 0001's post-handshake message.
    - bounding it needs a certificate lifetime, which is the same trade-off as T.
- **`.biometryCurrentSet` on iOS.** Every new face or fingerprint would destroy the Device.
- **`touchIDAuthenticationAllowableReuseDuration`.** It reuses a *lock-screen* biometric match for at most five minutes, and is not a way to hold an in-app authentication (**Documented**).
- **Keeping the Noise key in the Android Keystore as X25519.** See §3.

## Other traps found on the way

- **Capacitor 8.5.2 on the iOS 27.0 Simulator shows a blank page.**
  - **The symptom:** `native-bridge.js` calls `prompt(JSON.stringify({type: 'CapacitorCookies.isEnabled'}))` synchronously at document start, to read its config. On 27.0, WebKit never delivered that prompt to any `WKUIDelegate`: a logging proxy saw nothing, and the WebContent main thread sat in `WebChromeClient::runJavaScriptPrompt`.
  - **Scope:** it reproduced on two freshly created 27.0 devices, while 26.5 loaded normally. One early 27.0 launch did work, so the trigger is not fully pinned down.
  - **The fix:** a `WKUserScript` injected at document start from `webViewConfiguration(for:)`, which runs before Capacitor adds its own. It answers those two config prompts (`'false'`) and passes every other `prompt()` through.
  - **Still open:** whether a physical iOS 27 phone does the same. The spike app carries the shim, so the human test cannot tell. The shell card should check it.
- **`xcrun simctl … booted` is ambiguous once two simulators are booted,** and on this shared Mac another session's commands landed on the spike's simulator. Address simulators by UDID.
- **An iOS Simulator app built without signing has no `application-identifier`,** so every keychain call fails with `-34018`.

## What the device test settles

- iOS:
  - Secure Enclave key creation with `.userPresence`.
  - Repeated silent signing through the held context, including after ten minutes in front.
  - The signing latency.
  - Control Center and the call banner firing only `willResignActive`.
  - Lock ending it at the OS level, via the "Sign in 15 s" check.
- Android on real hardware:
  - StrongBox or TEE: security level, attestation root and latency.
  - The same prompt behaviour as the emulator for sign, sign again, background, the notification shade and lock.
