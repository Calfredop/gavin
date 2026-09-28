---
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
