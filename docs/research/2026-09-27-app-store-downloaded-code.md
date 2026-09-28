# Store policy: running a Workstation-served web bundle in the Companion

Researched 2026-09-27 against: App Review Guidelines ("Last Updated: June 8, 2026"); Apple Developer Program License Agreement (DPLA, "last updated August 18, 2026"); Google Play Device and Network Abuse policy as served on 2026-09-27; home-assistant/iOS at `65a93a5`; ionic-team/capacitor at `145560e`.

## Summary

1. **Verdict: allowed in principle, not as sketched.** Downloading publisher-signed interpreted code that stays within the app's advertised purpose is permitted (DPLA 3.3.1(B); Play's interpreter exception). Letting that code reach Capacitor plugins is not clearly compliant (Guideline 4.7.2; Play's JavaScript-interface rule).
2. **Bridge:** the bundle runs in its own WebView with no Capacitor bridge. It has one channel that the shell owns, with a fixed set of typed messages, checked by origin, reaching only its own Workstation. Keys, biometrics and push stay in the shell.
3. **Provenance:** the store shell runs only publisher-signed bundles from a paired Workstation, loaded from a local origin. It never navigates anywhere else and refuses unsigned or self-built bundles.
4. **Scope and review:** bundles add only UI for controlling the desktop. New phone-side capabilities ship as store updates. App Review gets a demo Workstation and review notes that explain the architecture.
5. **Residual risk:** Guideline 2.5.2 and Apple's 2020 HTML5 notice give a reviewer grounds to reject a UI delivered as HTML5. Home Assistant is close precedent, not a guarantee.

## 1. App Review Guidelines

Source: https://developer.apple.com/app-store/review/guidelines/

- **2.5.2:** "Apps should be self-contained in their bundles, and may not read or write data outside the designated container area, nor may they download, install, or execute code which introduces or changes features or functionality of the app, including other apps." Read literally, it bans all feature-changing downloaded code. Only the DPLA carve-out (§2) makes interpreted code possible.
- **4.7:** "Apps may offer certain software that is not embedded in the binary, specifically HTML5 and JavaScript mini apps and mini games, streaming games, chatbots, and plug-ins. … You are responsible for all such software offered in your app." Sub-items:
  - 4.7.1: privacy, content moderation, and 3.1 payments.
  - **4.7.2:** "Your app may not extend or expose native platform APIs or technologies to the software without prior permission from Apple."
  - **4.7.3:** "Your app may not share data or privacy permissions to any individual software offered in your app without explicit user consent in each instance."
  - 4.7.4: an "index of software and metadata" with universal links.
  - 4.7.5: an age-restriction mechanism.
- **Mini apps, as Apple defines them:** "software packages, scripts, or game content that are added after app installation and executed on the device, provided such code is written in HTML5 or JavaScript … All such code must comply with Section 3.3.1(B)" (https://developer.apple.com/programs/mini-apps-partner/). Read literally, that covers our bundle.
- **2020 HTML5 notice** (https://developer.apple.com/news/?id=01212020a): "the core features and functionality of the app must be contained within the software's binary, rather than made possible by referring users outside of the approved app — including through the use of HTML5." This is the strongest adverse text.
- **4.2:** apps must "elevate it beyond a repackaged website".
- **4.2.3(i):** "Your app should work on its own without requiring installation of another app to function."
- **4.2.7:** a remote-desktop app that "acts as a mirror of specific software" must connect only to "a user-owned host device … on a local and LAN-based network". The Companion renders its own UI rather than mirroring a screen, but this reading would conflict with the relay.
- **2.3.1(a):** "Don't include any hidden, dormant, or undocumented features"; new features "must be described with specificity in the Notes for Review".
- **2.1(a):** "include demo account info (and turn on your back-end service!)".

## 2. DPLA: executable and interpreted code

Source: https://developer.apple.com/support/terms/apple-developer-program-license-agreement/#ADPLA3.3. The current location is **§3.3.1 "APIs and Functionality", item B "Executable Code"**:

> "Except as set forth in the next paragraph, an Application may not download or install executable code. Interpreted code may be downloaded to an Application but only so long as such code: (a) does not change the primary purpose of the Application by providing features or functionality that are inconsistent with the intended and advertised purpose of the Application (b) does not bypass signing, sandbox, or other security features of the OS; and (c) for Applications distributed on the App Store, does not create a store or storefront for other Applications."

Third-party quotes that end "…as submitted to the App Store" reflect older wording. That history is from memory: **UNCONFIRMED**.

Neighbouring clauses that apply:

- **§3.3.1(C):** "Without Apple's prior written approval … an Application may not provide, unlock or enable additional features or functionality through distribution mechanisms other than the App Store".
- **§6.1:** "You further agree that You will not attempt to hide, misrepresent or obscure any features, content, services or functionality in Your submitted Applications from Apple's review".

## 3. Native API exposure

**As sketched, Capacitor gives the bundle every plugin.**

- **iOS:** one `WKScriptMessageHandler` named `"bridge"` dispatches any `pluginId`/`methodName`, with no check on frame or origin ([WebViewDelegationHandler.swift L192–215](https://github.com/ionic-team/capacitor/blob/145560ee590d86637dc9dd2e2c9f4c08b0f631c0/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift#L192-L215)).
- **Android:** `addWebMessageListener(webView, "androidBridge", bridge.getAllowedOriginRules(), …)`, falling back to `addJavascriptInterface` ([MessageHandler.java L26–41](https://github.com/ionic-team/capacitor/blob/145560ee590d86637dc9dd2e2c9f4c08b0f631c0/android/capacitor/src/main/java/com/getcapacitor/MessageHandler.java#L26-L41)).
- **Result:** downloaded JS could drive hardware-key signing, biometrics and push directly.

**Does 4.7.2 cover an app's own plugins?** No Apple text settles whether a first-party UI bundle is 4.7 "software offered in your app", or whether an app's own plugin counts as a "native platform API". **UNCONFIRMED.**

- **Against:** 4.7.4 and 4.7.5 (an index with universal links, per-item age gating) make no sense for a single first-party UI.
- **For:** the mini-app definition covers it literally, and a key or biometrics plugin literally wraps "native platform APIs or technologies".

Assume it applies. The constraint that avoids the question entirely is §7 items 1–3: the bundle never touches a plugin. Instead, it sends typed messages to its own Workstation through a shell-owned channel, and the shell uses the key and biometrics only for its own protocol.

## 4. Does the source of the code matter?

**Apple:** no. Neither 2.5.2 nor DPLA 3.3.1(B) mentions a source. They test what the code does: its purpose, security bypass, storefronts. Under 4.7, "You are responsible for all such software" wherever it comes from.

**Google:** partly.

- **Executable code:** the source matters. It may not come "from a source other than Google Play".
- **JS-interface WebViews:** the trust of the content matters: "untrusted web content … or unverified URLs obtained from untrusted sources". Google's remediation page asks for "only strictly scoped URLs and content owned by the app developer" (https://support.google.com/googleplay/android-developer/answer/10768383).

**Our signature is what makes the user's machine an acceptable source.** It makes the bundle "content owned by the app developer" whatever path it took. Gavin's desktop source is public, so a self-built desktop serves unsigned bundles. The store shell must refuse them. Otherwise it becomes a runtime for arbitrary code, which is exactly what the "primary purpose" and "storefront" limits target.

## 5. Precedents

**Home Assistant iOS** (App Store, seller "Nabu Casa, Inc": https://apps.apple.com/us/app/home-assistant/id1099568401):

- **Topology:** the WebView loads the frontend from the user's own server, including through Home Assistant Cloud (`remoteUIURL: … "https://ui.nabu.casa"`, [ServerFixture.swift L51](https://github.com/home-assistant/iOS/blob/65a93a5d2fb4122e4be051531b61956d32ff3ed8/Sources/Shared/API/Fixtures/ServerFixture.swift#L51)). That is our relay topology.
- **Handlers:** named ones, `externalBus`, `getExternalAuth` and others ([WebViewSetup.swift L8–17](https://github.com/home-assistant/iOS/blob/65a93a5d2fb4122e4be051531b61956d32ff3ed8/Sources/App/Frontend/WebView/WebViewController/WebViewController+WebViewSetup.swift#L8-L17)).
- **Origin gate:** the handlers sit behind `SafeScriptMessageHandler`: "Only the top-level document on an allowed server origin may talk to the native bridge" ([L15–35](https://github.com/home-assistant/iOS/blob/65a93a5d2fb4122e4be051531b61956d32ff3ed8/Sources/App/Frontend/ExternalMessageBus/SafeScriptMessageHandler.swift#L15-L35)).
- **Closed vocabulary** ([WebViewExternalBusMessage.swift L8–37](https://github.com/home-assistant/iOS/blob/65a93a5d2fb4122e4be051531b61956d32ff3ed8/Sources/App/Frontend/ExternalMessageBus/WebViewExternalBusMessage.swift#L8-L37)): `config/get`, which returns capability flags; NFC `tag/read`/`tag/write`; `matter/commission`; `thread/store_in_platform_keychain`; `bar_code/scan`; `haptic`.
- **Android:** the V2 bridge "Uses WebViewFeature.WEB_MESSAGE_LISTENER for secure origin validation" (https://developers.home-assistant.io/docs/frontend/external-bus/).

So an approved app does expose narrow native actions to JS it did not ship. Whether Nabu Casa holds 4.7.2 "prior permission" is **UNCONFIRMED**. One difference: Home Assistant loads a live page and does not cache a bundle. Both are interpreted code.

**Live-update vendors** confine themselves to the web layer and promise nothing:

- **Capgo** (https://capgo.app/docs/live-updates/compliance/): "does not change your native binary, native plugins, permissions, entitlements"; "Ship a normal native release for native capabilities or material functionality changes"; it "cannot guarantee an individual App Store or Play Store approval".
- **Ionic Appflow** (https://ionic.io/docs/appflow/deploy/intro): "only works on binary compatible changes (HTML, CSS, and JS). If you change native code, such as adding or removing a plugin … you must resubmit".
- **Expo EAS Update** (https://docs.expo.dev/eas-update/introduction/): "changes to your app's behavior need to be reviewed". It offers end-to-end signing, "verified on the client before the update is applied" (https://docs.expo.dev/eas-update/code-signing/).

## 6. Google Play

Source: https://support.google.com/googleplay/android-developer/answer/9888379 (identical text at …/answer/16559646).

> "An app distributed via Google Play may not modify, replace, or update itself using any method other than Google Play's update mechanism. Likewise, an app may not download executable code (such as dex, JAR, .so files) from a source other than Google Play. This restriction does not apply to code that runs in a virtual machine or an interpreter where either provides indirect access to Android APIs (such as JavaScript in a webview or browser)."

> "Apps or third-party code, like SDKs, with interpreted languages (JavaScript, Python, Lua, etc.) loaded at run time (for example, not packaged with the app) must not allow potential violations of Google Play policies."

Listed violation: "a webview with added JavaScript Interface that loads untrusted web content (for example, http:// URL) or unverified URLs obtained from untrusted sources".

- **The bundle itself** is covered by the interpreter exception.
- **The sketched bridge** makes access to Android APIs close to direct, not "indirect". The narrow channel in §7 fixes that.

**Newer:** the July 15, 2026 announcement (https://support.google.com/googleplay/android-developer/answer/17134731) does not touch code loading, and I found no 2025–2026 change to this paragraph. The Functionality policy (https://support.google.com/googleplay/android-developer/answer/9898783) rejects apps "static without app-specific functionalities". The shell's native features answer that.

## 7. Verdict and constraints for the spec

**The sketch is not clearly compliant.** The downloaded code has plugin access, and nothing binds it to publisher code or to the reviewed scope. The smallest change that makes it compliant is to adopt these constraints:

1. **Separate WebView, no Capacitor bridge,** for Workstation bundles. The Capacitor WebView hosts only the hub UI that ships in the binary.
2. **One shell-owned channel.** It carries a closed, versioned set of message types, accepts them only from the main frame and the bundle origin, and reaches only the active Workstation. No generic plugin, crypto, file or keychain calls. Capabilities are advertised the way `config/get` does it, so older or newer bundles degrade instead of breaking.
3. **Native trust stays native.** The shell alone uses the hardware key, biometrics and push, and signs only messages of its own protocol with its own Workstation. Permissions are requested in native UI (4.7.3).
4. **Signed-only, local-only.** Verify the publisher signature and serve from an app-local origin. Block every other navigation; external links open in the system browser. Refuse unsigned or self-built bundles in store builds.
5. **Purpose lock.** A bundle only presents controls for the user's own Gavin desktop. New native capabilities, new permissions, or a change of purpose require a store release.
6. **Reviewability.** Provide a hosted demo Workstation, or an approved demo mode (2.1(a)). Review notes state that the UI is served by the user's desktop and signed by us (2.3.1(a); DPLA 6.1). The store description covers terminals, board, git, files and settings.

**Residual risk:**

- **2.5.2 and the 2020 notice.** A reviewer can still reject a UI "made possible … through the use of HTML5". The precedents reduce this risk; they do not remove it.
- **Other readings.** 4.2.7 (LAN-only mirror), 4.2.3(i) (requires another app) and DPLA 3.3.1(C) are each arguable, and none is settled by primary text.
- **Fallback if rejected:** also embed the UI in the binary, and treat Workstation-served bundles as live updates of it.
