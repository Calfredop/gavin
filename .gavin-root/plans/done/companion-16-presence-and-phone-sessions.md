---
order: 18432
kind: task
title: Companion 16: presence and phone-started sessions at the desk
status: Done
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

- [x] Seam 1: presence pushes reflect the forwarded activity of two Devices at once
- [x] Pure-module tests for placing a Device-started session as a labelled tab
- [x] Sessions the desktop launches itself are unaffected
- [ ] Human test: With a v58 daemon and dev app (companion/wire, rebuilt and restarted) and a paired test Device: run a card from the Device — at the desk it opens as a tab on that workspace's Agents page labelled "<session> · <Device name>"; type into a terminal from the Device — its tab shows the Device marker, which clears a few seconds after typing stops; the Devices panel row says where the Device is and what it started.

When done, file a human test: run a card from the test Device; at the desk it's a tab labelled with the Device, and typing from the Device shows the marker.
