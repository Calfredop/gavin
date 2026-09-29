---
order: 4096
kind: task
title: Companion 24: early store review
status: In Progress
labels: ready-for-human
parent: companion.md
complexity: moderate
---
Blocked by: companion-23-served-signed-ui.md

Part of `companion.md`. Read ADR 0005's "Store compliance" section and the store research (`docs/research/2026-09-27-app-store-downloaded-code.md`) first.

## What to build

**Mostly the owner's work:** developer accounts, signing and App Store Connect. An agent prepares everything else, and can use `/wizard` for the steps only a human can do.

- **Submit** the first end-to-end build (ticket 23) for **full App Store review with manual release**. Approval publishes nothing. Also submit it to Play internal testing.
- **Write the review notes:**
  - the UI is served by the user's own desktop and signed by the publisher;
  - the built-in Demo Workstation is for reviewers, with no account and no pairing;
  - the store description covers terminals, board, git, files and settings.
- **Record Apple's response on this card.** If it is a rejection, file the fallback against ADR 0005.

## Acceptance criteria

- [ ] Both submissions are made, with the review notes
- [ ] The outcome is recorded here
- [ ] ADR 0005 is updated if Apple's answer changes it
- [ ] Decision: Companion 23 (end-to-end signed UI) is still To Do, blocked by 22 and 13. Agent prep (review notes, store description, owner wizard) is on this card. Wait for 23 before any store submit, or submit the current Demo-only shell early against ADR 0005?
  Options: A) Wait for companion-23 B) Submit Demo-only shell now
- [ ] Human test: After companion-23 is Done: submit the end-to-end iOS build to App Store Connect for full review with Manual Release, using the Prepared App Store Notes for Review on this card. Record version/build and confirm approval will not publish.
- [ ] Human test: After companion-23 is Done: upload the release AAB to Play Console Internal testing with the Prepared Play notes on this card. Record the internal release name/version under Play internal testing on this card.
- [ ] Decision: When App Review replies: paste the decision, date, and any guideline cites into Apple's response on this card. If rejected, say so here so ADR 0005 can get the binary-embed fallback.

## Blocker (2026-09-28)

Cannot submit yet. `companion-23-served-signed-ui` is still **To Do**, and itself blocked by `companion-22-unlock-live-hub` (To Do) and `companion-13-desktop-answers-forwarded` (In Progress). ADR 0005 and the build order require the first **end-to-end** build (ticket 23), not the Demo-only shell that exists today (`com.gavin.companion`).

Agent prep below is ready to paste the moment that build exists. Submissions wait on 23 + the owner's accounts.

## Prepared: App Store — Notes for Review

Paste into App Store Connect → App Review Information → Notes:

```
Gavin Companion is a remote control for the user's own Gavin desktop (a
coding-agent workstation on their Mac/PC). It is not a website wrapper.

How the UI works
- Paired Workstations serve a publisher-signed web UI bundle over an
  encrypted channel. The shell verifies the signature against a key pinned
  in the binary, then runs the bundle in a separate webview with no
  Capacitor / native-plugin bridge. The bundle's only outlet is a closed,
  versioned message channel owned by the shell (invoke/listen to that
  Workstation alone; open external links in Safari; return to the hub).
- Bundles never change native capabilities, permissions, or the app's
  purpose. Those ship only as store updates.
- This matches DPLA §3.3.1(B) (interpreted code that keeps the advertised
  purpose) and Guideline 4.7.2 (no exposure of native platform APIs to
  downloaded software).

Demo for reviewers (no account, no pairing)
- Open the app. The Workstations hub lists "Demo Workstation".
- Tap it. You get a full working UI (sample sessions, cards, rails) at the
  same version as this binary. No login, no backend, no pairing required.
- That satisfies Guideline 2.1(a) without a hosted server or reviewer Device.

What to exercise
- Demo Workstation: browse terminals, board/cards, rails, git, files, settings.
- Hub only: the Demo entry is enough for review. Pairing a real desktop is
  optional and needs the user's own Gavin install.

Release
- Version submitted with Manual Release. Approval must not publish.
```

## Prepared: store description (App Store + Play)

Short description / subtitle-length:

```
Remote control for your Gavin desktop — terminals, board, git, files, settings.
```

Full description:

```
Gavin Companion puts your Gavin workstations in your pocket.

Pair each phone once at your desk. One Face ID or passcode Unlock gives full
control of the running desktop until you background the app or lock the phone.

From the Workstations hub you open the same surfaces you use at the desk:
terminals (with compose and raw typing), the kanban board and cards, rails
and orchestration, Git, files, and settings. Everything goes through your
own desktop — it must be running — via an encrypted relay you can self-host.

A built-in Demo Workstation lets you explore the app with no account and no
pairing. Managing Devices stays at the desk.
```

## Prepared: Play Console — notes for internal testers

```
Internal testing build of Gavin Companion.

Architecture: the store binary is a native shell (hub, pairing, Unlock,
keys). Each paired Workstation serves a publisher-signed UI bundle; the
shell verifies the signature and runs it in a separate process/webview
with no JavaScript interface to native plugins — only a closed message
channel. Matches Play's interpreter exception and JS-interface rule.

Reviewers / testers: open the app → Demo Workstation. No account, no
pairing. Full sample UI for terminals, board, git, files, settings.
```

## Owner submission wizard (when companion-23 is Done)

Do these in order. Bundle id / applicationId is `com.gavin.companion`; display name **Gavin**.

### A. Accounts and signing (once)

1. Apple Developer Program membership active; create App ID `com.gavin.companion` if missing.
2. App Store Connect: new iOS app, bundle id `com.gavin.companion`, name Gavin Companion (or Gavin — match ASC uniqueness).
3. Google Play Console: create app, package `com.gavin.companion`; enrol in Play App Signing.
4. Xcode: Development Team on the App target; archive a **Release** (non-probe) build from the companion-23 end-to-end tree after `npm run companion-shell:sync -- ios`.
5. Android Studio / `./gradlew bundleRelease`: upload an AAB signed for Play.

### B. App Store — full review, manual release

1. Upload the archive via Xcode Organizer or `xcrun altool` / Transporter.
2. Fill metadata: paste the store description above; privacy nutrition / privacy policy URL as you already use for Gavin.
3. Paste **Prepared: App Store — Notes for Review** into Notes for Review.
4. Demo account fields: leave blank; notes already say Demo Workstation needs none.
5. Version → **Manually release this version** (not automatic).
6. Submit for App Review.
7. Paste Apple's decision under **Apple's response** below (approve / reject + guideline cites). Approval must not release.

### C. Play — internal testing

1. Play Console → Testing → Internal testing → create release → upload AAB.
2. Add yourself (and any testers) to the internal testers list.
3. Paste the Play notes above into the release notes / tester instructions.
4. Roll out to internal track (not production).
5. Note the release name/version under **Play internal testing** below.

## Apple's response

_(empty — fill when App Review replies)_

- Decision:
- Date:
- Guideline cites (if any):
- Notes:

If rejected: update ADR 0005 "Store compliance" / residual risk with the fallback from the research doc — also embed the UI in the binary, and treat Workstation-served bundles as live updates of it — and record the ADR edit on the third acceptance item.

## Play internal testing

_(empty — fill when the internal release is live)_

- Track: internal
- Version / release name:
- Date:
