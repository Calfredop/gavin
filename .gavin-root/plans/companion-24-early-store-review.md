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
- [x] Decision: Companion 23 (end-to-end signed UI) is still To Do, blocked by 22 and 13. Agent prep (review notes, store description, owner wizard) is on this card. Wait for 23 before any store submit, or submit the current Demo-only shell early against ADR 0005?
  Options: A) Wait for companion-23 B) Submit Demo-only shell now
  Moot (2026-09-30): companion-23 is Done, so there is no Demo-only-or-wait choice left. The submission uses its build. The live question is the next one.
- [ ] Decision: The end-to-end build (companion-23) shows a paired desktop's workspaces and boards READ-ONLY. Terminals (companion-26) and git/files (29) are In Progress, and card actions, rails and settings (27, 28, 30) are To Do. Submit it now, as ADR 0005 says, to learn Apple's stance on served bundles early? The risk is a Guideline 4.2 "minimum functionality" rejection, which would answer nothing about the architecture. Or wait for companion-26, so the reviewer sees terminals too? Recommended: B, since 26 is already In Progress and a 4.2 rejection would cost a review cycle without the answer this card exists for.
  Options: A) Submit the read-only build now B) Wait for companion-26 (terminals), then submit
- [ ] Decision: The shell targets iPhone AND iPad (TARGETED_DEVICE_FAMILY 1,2), so App Store Connect wants 13" iPad screenshots and App Review may test on an iPad. Nothing in the Companion has been designed or checked for iPad. Make the first submission iPhone-only (it still runs on iPad in compatibility mode)? Recommended: A.
  Options: A) iPhone-only for now B) Keep iPhone + iPad
- [ ] Human test: On a phone or Simulator with a release sync of `companion/desk-prep` (`npm run companion-shell:sync -- ios android --release`), check the new home-screen icon (iOS rounded tile; Android adaptive ">G" on dark, in a circle and a squircle launcher) and the dark launch screen look right and not cropped. They were drawn by `app/companion-shell/scripts/icons.mjs` from the desktop's icon.svg.
- [ ] Human test: After companion-23 is Done: submit the end-to-end iOS build to App Store Connect for full review with Manual Release, using the Prepared App Store Notes for Review on this card. Record version/build and confirm approval will not publish.
- [ ] Human test: After companion-23 is Done: upload the release AAB to Play Console Internal testing with the Prepared Play notes on this card. Record the internal release name/version under Play internal testing on this card.
- [ ] Decision: When App Review replies: paste the decision, date, and any guideline cites into Apple's response on this card. If rejected, say so here so ADR 0005 can get the binary-embed fallback.

## Blocker (2026-09-28)

Cannot submit yet. `companion-23-served-signed-ui` is still **To Do**, and itself blocked by `companion-22-unlock-live-hub` (To Do) and `companion-13-desktop-answers-forwarded` (In Progress). ADR 0005 and the build order require the first **end-to-end** build (ticket 23), not the Demo-only shell that exists today (`com.gavin.companion`).

Agent prep below is ready to paste the moment that build exists. Submissions wait on 23 + the owner's accounts.

**Update (2026-09-30):** companion-23 is Done (committed on `companion/phone`, a528f161). The early-submit decision above is moot: the submission uses its end-to-end build. A readiness pass over the shell found gaps that would stop the upload or invite a rejection, whatever the review notes say. They are the plan below. The work is on branch `companion/desk-prep` (worktree `.gavin-worktrees/companion-desk-prep`).

## Plan (agent prep, 2026-09-30)

- [x] iOS privacy manifest: the App target reads `UserDefaults` (in three plugins) with no `PrivacyInfo.xcprivacy`, so App Store Connect would refuse the upload (ITMS-91053). Added `ios/App/App/PrivacyInfo.xcprivacy` with reason CA92.1, no tracking and nothing collected, and registered it in the Xcode project. Capacitor's package ships its own
- [x] App icons: iOS and Android still had Capacitor's placeholder icon (the blue X on a grid). `scripts/icons.mjs` now draws them from `app/src-tauri/icons/icon.svg`: the iOS icon is the tile full-bleed at 1024, opaque; Android gets an adaptive icon, the ">G" glyphs inside the 66dp safe circle on the tile colour; plus `store/play-icon-512.png`
- [x] Splash: Capacitor's placeholder replaced with the ">G" mark on the tile's dark colour, for iOS and every Android density and orientation
- [x] Android release signing: `bundleRelease` now signs with the upload key named in `android/keystore.properties` or `GAVIN_ANDROID_UPLOAD_*` (keystore files gitignored). Without either it stays unsigned. `-PversionCodeOverride=N` sets the versionCode
- [x] Review notes: checked against the build. The message types, the "Demo Workstation" label and Safari for external links hold. The surfaces did not: the first draft listed terminals, git, files, settings and rails, and none is in this build. Rewritten into `store/` to describe what ships (see below)
- [x] Owner wizard: `scripts/store-submit.sh` (see below)
- [x] Checks: shell vitest 241/241. svelte-check reports 1 error, which predates this work and sits in `src/shell/bundle/bundle.e2e.ts:182` (a manifest cast), a file this work does not touch. Built with `companion-shell:sync -- ios android --release`. `xcodebuild` Release for `generic/platform=iOS`, unsigned: BUILD SUCCEEDED, and the .app carries `PrivacyInfo.xcprivacy`, the icon and only the demo bundle, with no dev key. `bundleRelease` against a throwaway key gave a signed AAB (`jarsigner -verify`: jar verified), unsigned without the key, versionCode override honoured

Uncommitted on `companion/desk-prep`: `app/companion-shell/{ios/App/App/PrivacyInfo.xcprivacy, ios/App/App.xcodeproj/project.pbxproj, android/app/build.gradle, android/.gitignore, scripts/icons.mjs, scripts/store-submit.sh, store/, README.md}` plus the regenerated icon and splash PNGs and `values/ic_launcher_background.xml`.

## Prepared: App Store — Notes for Review

The review notes, the store description, the listing and the Play release notes are now files that live with the build they describe: `app/companion-shell/store/` (on `companion/desk-prep`), and the wizard copies each one to the clipboard at the step that needs it:

- `app-review-notes.txt` goes in ASC → App Review Information → Notes. It covers the UI the user's own desktop serves, signed by the publisher and run with no native bridge (DPLA 3.3.1(B), Guideline 4.7.2), and the built-in Demo Workstation for reviewers, which needs no account and no pairing.
- `description.txt` and `listing.txt` are the App Store and Play description, name, subtitle, keywords, promotional text and Play short description.
- `play-release-notes.txt` is for Play internal testing.

**These describe what the companion-23 build does, not the finished product.** That build is the hub, pairing, Unlock, the inbox, and each workspace's board to read (`app/companion/README.md`, "What is here"). Terminals, card actions, rails, git, files and settings are companion-26 to -30, and none has landed. The first draft on this card listed all of them. Guideline 2.3 rejects metadata that names what a build cannot do, and a reviewer checks the Demo against it. Widen the texts as those cards land (the rule is in `store/README.md`).

## Owner submission wizard

`app/companion-shell/scripts/store-submit.sh` (on `companion/desk-prep`). Eleven stages, each asking before any upload or submit:

1. Publisher key: generate it on a machine that runs no agents, and paste only the public half, which the wizard pins in `publisherKey.ts` (companion-23's open decision).
2. Apple App ID `com.gavin.companion`, and your Team ID.
3. The App Store Connect app record.
4. The Play Console app.
5. The Play upload key, stored in `android/keystore.properties` (gitignored).
6. A release sync, then the iOS archive and the AAB, with a build number.
7. Upload to App Store Connect (`xcodebuild -exportArchive`), or through the Organizer instead.
8. The ASC listing and screenshots.
9. Privacy, age rating, and the encryption facts. The app uses Noise (X25519, ChaCha20-Poly1305, BLAKE2s) and Ed25519, all standard algorithms, and the exemption is the owner's legal answer.
10. Review notes, **Manually release this version**, then submit.
11. Play internal testing.

It ends by printing the lines to record below.

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
