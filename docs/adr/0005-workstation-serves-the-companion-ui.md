# Each Workstation serves the Companion UI it speaks

Remote invoke (ADR 0003) calls Tauri commands by name, with arguments shaped for one build. On the desktop, the webview and the host always ship together. A store-distributed Companion breaks that pairing: it updates on the store's schedule, and every Workstation runs its own version.

We decided the Companion from the store is only a native shell. It holds the Workstations hub, the combined attention inbox, pairing, the Unlock, notifications and the keys. The UI for working on a Workstation is a web bundle built from the same commit as that Workstation's desktop app. The Workstation ships the bundle and serves it to the Device over the encrypted channel. The publisher signs every bundle, and the shell refuses any bundle whose signature does not check against the publisher key it pins. That way a compromised Workstation cannot run code in the webview that also holds the Device's keys for its other Workstations.

## Considered options

- **The Companion carries its own UI, with a compatibility window per Workstation version.** Rejected: every Tauri command would become a versioned public API, a permanent tax on a codebase whose commands change daily.

## The one stable API

The shell's combined attention inbox cannot run each Workstation's code. So the shell asks every Workstation one small, versioned question: what is waiting, and what state the Workstation is in. This is the only surface between the shell and a Workstation that must stay compatible across versions, and it is kept to a few fields on purpose. Pushes also carry "resolved", so an item handled at the desk leaves the phone too.

## Consequences

- There is no version skew between the UI and the commands it calls.
- Each Workstation's UI is exactly as new as the Workstation itself.
- The desktop build now also produces and signs the Companion bundle.
- The shell caches bundles by content hash.

## Store compliance

`docs/research/2026-09-27-app-store-downloaded-code.md` found the architecture allowed in principle, but not as first sketched. Apple's DPLA §3.3.1(B) and Google Play's interpreter exception permit downloaded JavaScript that keeps the app's purpose. Capacitor, however, hands every plugin to any script in its webview, and that conflicts with Guideline 4.7.2 ("may not extend or expose native platform APIs") and with Play's JavaScript-interface rule. So:

- **Bundles run in a separate webview with no Capacitor bridge.** It is still rendered seamlessly inside the Companion: a full-screen view in the app's own navigation, never a browser.
  - **Never an iframe in the shell's webview.** Capacitor's iOS bridge answers every frame, so any frame there can call every plugin.
  - **On Android, that webview runs in its own app process.** Otherwise it shares one renderer process with the shell's webview, which holds the Noise key and every Workstation's live connection.

  Both were measured in `docs/research/2026-09-28-companion-device-keys.md`.
- **The bundle's one outlet is a channel the shell owns.** It carries a closed, versioned set of typed messages, accepts them only from the bundle's origin, and reaches only that bundle's own Workstation. Remote invoke's `invoke` and `listen` are two of those message types.
- **Native trust stays native.** Only the shell touches the hardware key, biometrics and push.
- **Only signed bundles run, from an app-local origin.** Every other navigation is blocked, and store builds refuse unsigned or self-built bundles.
- **A new phone-side capability, a new permission or a change of purpose ships as a store release**, never in a bundle.
- **The binary carries a Demo Workstation**: the Companion UI at the store build's version, over a simulated Workstation with sample sessions, cards and rails. Reviewers and not-yet-paired users can explore a working app. This answers Guideline 2.1(a)'s demo requirement without a hosted Workstation or reviewer pairing. It also lets the review notes describe served bundles as version-matched updates of a UI already in the binary.
- **The first build that works end to end is submitted for full App Store review, with manual release**, so Apple's stance is known before the rest of the release is built on it.

**Residual risk:** Guideline 2.5.2 and Apple's 2020 HTML5 notice ("core features and functionality of the app must be contained within the software's binary") still give a reviewer grounds to reject. Home Assistant's companion app, which loads its UI from the user's own server behind an origin-gated message bus, is close precedent but not a guarantee.
