---
kind: task
title: Companion 16: presence and phone-started sessions at the desk
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-13-desktop-answers-forwarded.md, companion-15-devices-panel.md

Part of `companion.md`. Read the spec (sections "Forwarding to the desktop app" and "The desktop app") first.

## What to build

- **Presence.** The daemon tracks each Device's presence from its forwarded traffic (which workspace it is in, which session it is typing into, which sessions it started) and pushes that to the desktop app.
- **Showing it.** The Devices panel lists presence, and a terminal shows a marker while a Device types into it.
- **Sessions started from a phone** open as a tab in their workspace's page, labelled with the Device's name. The desktop learns this from a push naming the originating Device.

## Acceptance criteria

- [ ] Seam 1: presence pushes reflect the forwarded activity of two Devices at once
- [ ] Pure-module tests for placing a Device-started session as a labelled tab
- [ ] Sessions the desktop launches itself are unaffected

When done, file a human test: run a card from the test Device; at the desk it's a tab labelled with the Device, and typing from the Device shows the marker.
