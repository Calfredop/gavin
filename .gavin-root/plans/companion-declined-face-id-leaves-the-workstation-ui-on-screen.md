---
order: 13312
kind: task
title: Companion: after Face ID is declined, an open Workstation's UI stays on screen with its data
status: To Do
priority: high
complexity: moderate
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (A7), on a physical iPhone 16 Pro (iOS 27.0), debug build, paired with the owner's real Workstation `MBP16Pro`. The owner's words: "the hub stays unlocked even when faceid fails".

**Sequence (hub console hook, seconds on the page's clock).**
- 94.9 s `[gavin-unlock] background: unlocked -> locked (background)`, `[gavin-hub] ws-b8b62138dff5ea6a: locked`
- 104.3 s foreground -> `unlocking`; 104.9 s `prompt-succeeded`; 105.3 s `ready, 209 waiting` (A5 passes: one prompt per foreground, no loop)
- 111.7 s background again -> `locked`
- 131.5 s foreground -> `unlocking`; the owner CANCELLED Face ID; 139.3 s `prompt-declined: unlocking -> locked (declined)`

**What is still true afterwards.**
- The hub (`capacitor://localhost`) is correct: it reads `Locked. Unlock to connect to your Workstations.` with an `Unlock` button, and `MBP16Pro` shows `Locked`; its inbox is gone.
- The Workstation's own UI, the bundle webview `gavin-bundle://ws-b8b62138dff5ea6a/` (alive 1,090 s, `visibilityState: visible`, `hasFocus: true`), was NOT closed or covered. It still shows the real Gavin workspace: the Sessions list, the board with `To Do 19 / In Progress 15 / Done 6` and the card titles, the Git change list (file names), Files. The phone's real data is readable on screen after the owner refused Face ID.
- Live calls do fail, which is right: opening Git sent `git_repo_info`, `git_watch` and the bundle showed `Refresh failed: The Workstation cannot be reached right now.` with a Dismiss button; `lsof` on the Mac shows no phone connection to the Relay port. So the Unlock gates the connection; it does not gate the screen.
- Inside the bundle there is no way to unlock: no lock overlay, no Unlock button, only the error banner. The way back is to leave to the hub and press `Unlock` there.

**Why it matters.** The Unlock is the Companion's one gate (ADR 0004) and the spec says it ends on background and lock. A person who cancels (or fails) Face ID, or a bystander handed the phone, still sees the open Workstation's cards, session names and file names until they navigate away. README: on Android "the Unlock asks, over whichever is in front"; the iOS shell does ask over the bundle, but a refusal leaves the bundle as it was.

**To do.**
- When the Unlock ends (background, screen lock, decline), cover the bundle webview with the shell's lock view, or close the visit and return to the hub. Pick by cost: closing loses the bundle's place, covering keeps it.
- Show an Unlock button on that cover and re-ask on tap; after a successful Unlock the open Workstation reconnects (its listens are re-registered, per `workstationEndpoint.ts`).
- Decide whether the bundle's last-seen view should be cleared from memory on lock (cards, file names) rather than just hidden.
- Tests in `app/companion-shell/src/shell/` for visit + unlock: decline with a visit open -> the bundle is hidden.

**Acceptance.**
- [x] Cancelling Face ID with a Workstation open leaves no Workstation data visible
- [ ] The locked state offers an Unlock that returns to the same Workstation
- [x] Backgrounding does the same (Home seen on the phone; screen lock not tried separately)
- [ ] Android is checked: the bundle runs in its own process (`:bundle`)
- [ ] Human test: open a Workstation, press Home, reopen, cancel Face ID; nothing of the Workstation is visible; press Unlock, approve; the Workstation is back

## Progress (2026-10-08, same session)

The owner decided: when the Unlock ends inside a paired Workstation, go back to the Workstations hub (close the visit), not cover it. Implemented, uncommitted in the shared tree:
- `app/companion-shell/src/shell/unlock/leaveOnLock.ts`: `leavesVisitOnLock(unlock, visit)`, true when the Unlock is `locked` (any reason) and a PAIRED Workstation is `opening` or `open`. The Demo Workstation is excluded on purpose: it needs no connection and shows nothing of the owner's.
- `app/companion-shell/src/routes/+page.svelte`: one `$effect` that calls `visits.close()` when the rule says so.
- `leaveOnLock.test.ts`: 10 cases. `npm run companion-shell:test` passes (253), `companion-shell:check` shows only the existing `bundle.e2e.ts:182` type error.
- Still open from the list above: the cover-with-Unlock-button option was NOT built; clearing the bundle's last-seen data from memory (closing the visit tears the webview down, so it is gone with it); Android (the bundle runs in `:bundle`, `BundleView.close` crosses processes) is untested.
- Acceptance first box needs the phone: a debug build with this change is on the owner's iPhone for the Human test below.

**Device check, Home case (2026-10-08 17:31, iPhone 16 Pro, console + inspector):** a paired Workstation open (`bundle eec8fa25eb51… cached`, session 1), Home pressed: `background: unlocked -> locked (background)`, `[gavin-hub] ... locked`, `DeviceKeys lock`, then `BundleView close`; on reopen `foreground -> unlocking`, `prompt-succeeded`, `ready, 212 waiting`. The inspector then listed only `capacitor://localhost`: the Workstation's webview was gone and the hub was in front. The declined-Face-ID case is still to be checked on the phone.

**Device check, declined case (2026-10-08, console + inspector):** with MBP16Pro open, Home then reopen then Face ID cancelled: `background: unlocked -> locked (background)`, `[gavin-hub] ... locked`, `BundleView close` (before the foreground), `foreground -> unlocking`, `prompt-declined: unlocking -> locked (declined)`; the owner then tapped Unlock (`unlock-requested: locked (declined) -> unlocking`). The inspector listed only `capacitor://localhost`, so the Workstation's webview no longer existed while the prompt was declined. Acceptance boxes 1 to 3 are met on iOS; Android is still open.
