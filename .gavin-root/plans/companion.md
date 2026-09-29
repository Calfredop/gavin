---
order: 34816
title: The Companion: Gavin on a phone
status: To Do
priority: medium
labels: ready-for-agent
attachments: docs/superpowers/specs/2026-09-27-companion-design.md,CONTEXT.md,docs/adr/0001-device-key-is-two-keys.md,docs/adr/0002-companion-is-capacitor.md,docs/adr/0003-companion-drives-the-desktop-app.md,docs/adr/0004-one-unlock-gives-full-control.md,docs/adr/0005-workstation-serves-the-companion-ui.md,docs/research/2026-09-27-app-store-downloaded-code.md
complexity: intricate
---
An iOS and Android Companion that gives the human their Workstations in their pocket. The human pairs each Device once at the desk. One Face ID or passcode Unlock gives full control until the app is backgrounded or the phone locks. The Workstations hub gathers one attention inbox across every Workstation, and notifications are end-to-end encrypted. Picking a Workstation opens the desktop's own surfaces, served by that Workstation and signed by the publisher: terminals with compose and raw typing, board, cards, rails, Git, files and settings. Everything goes through a Relay, public or self-hosted, and the desktop app must be running. Only managing Devices stays at the desk.

**Spec:** `docs/superpowers/specs/2026-09-27-companion-design.md`. Read it first.

**Decisions:**
- ADR 0001: two keys per Device.
- ADR 0002: Capacitor.
- ADR 0003: the Companion drives the running desktop app.
- ADR 0004: one Unlock gives full control.
- ADR 0005: each Workstation serves the UI it speaks, under store-compliance constraints.

**Glossary:** `CONTEXT.md`.

**Store policy:** `docs/research/2026-09-27-app-store-downloaded-code.md`.

Tickets are task cards nested under this plan, each with its own status and a `Blocked by:` first line. Rails sequence them.

## Comments

**2026-09-28, typing prototype (card companion-01-typing-prototype), provisional.** The bench is on branch `prototype/companion-typing`, in `prototypes/companion-typing/`; its README has the detail.

The spec's typing decision (compose field by default, quick replies from the turn verdict, raw mode with a special-key row one tap away) **stands for now**. The owner's pick on a real phone is still outstanding, and this comment gets updated when it arrives. Building the bench showed the decision needs these amendments:

1. Compose sends `term.paste(text)` and then `\r`. xterm adds the bracketed-paste markers only while the program has switched that mode on, which matches the desktop's envelope and keeps cooked-mode prompts (a y/n line) working.
2. Menu quick replies send bare keys, not lines: the digit for a numbered menu, arrow presses plus Enter for an unnumbered one. (Modelled on Claude Code from memory; check against a real session.)
3. The turn verdict decides whether quick replies show at all. The options come from parsing the screen tail. Only free-text questions get canned words (`Yes`, `No`, `Continue`).
4. `Esc` and `^C` stay pinned in the compose dock; they are the only raw keys someone composing needs.
5. The Companion must send the PTY resize when the soft keyboard opens and closes. A live prompt redraws wrongly across a dock resize, and rows are scarce (about 31 on an iPhone 17 with no keyboard, roughly 13 with it up, estimated).
6. Compose is the better place for pasting: xterm turns off native selection and the raw-mode Paste key depends on a clipboard read that sandboxes and plain-http pages refuse.

Verified in the iOS Simulator (Mobile Safari 26.5, real WebKit) and Chrome: the page runs and its 13-check self-test passes. **Not verified until the human test:** touch scrolling on xterm 6.1.0-beta.304, selection and copy by touch, the keyboard covering the terminal, input methods, and Android Chrome.

**2026-09-28, typing prototype result (card companion-01-typing-prototype): the spec's typing decision is confirmed, with amendments.**

The owner answered the fake agent in Raw, Compose and Both on their own iPhone, marked the human test passed, and picked **Both**: the compose field with quick replies by default and raw keys one tap away, exactly as the spec's "Typing" point says. Amendments 1 to 6 in the comment above stand, and one is added:

7. **The quick-reply bar scrolls horizontally when its content exceeds the width.** The bench's derived chips already do; `Esc` and `^C` sit pinned outside the scroll. The owner did not say whether that pair should scroll with the bar, so keep them pinned unless told otherwise.

Reported problems: only that the Send button's styling is too basic and out of line with the rest of Gavin's UI. No scrolling, selection, keyboard or input-method problem was reported. ADR 0002 has the Companion styled the desktop's way, so build the compose bar from the desktop's components rather than copying the bench's buttons.

Still untested: **Android Chrome**. Only an iPhone was used, so the card's "iPhone Safari and Android Chrome" criterion is half met. The spec's typing point can move from "provisional" to settled for iOS; give the terminals ticket (`companion-26-terminals`) an Android check before it ships there.
