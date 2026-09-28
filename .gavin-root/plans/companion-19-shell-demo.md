---
kind: task
title: Companion 19: Companion shell with the Demo Workstation
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-09-web-bundle-demo.md

Part of `companion.md`. Read the spec (section "The Companion shell"), ADRs 0002 and 0005 (with its "Store compliance" section), and the store research first.

## What to build

The store app: a Capacitor project for iOS and Android, styled the desktop's way.

- **The hub.** The Workstations hub lists the Demo Workstation.
- **The bundle webview.** Picking the Demo Workstation opens the Companion web bundle from ticket 09 (embedded in the binary for the demo) in a **separate webview with no Capacitor bridge**, rendered full-screen inside the app's own navigation.
- **The shell side of the channel.** It checks the origin, carries the closed message set, and reaches only that bundle's own Workstation (here, the demo).
- **External links** open in the system browser. Nothing else navigates.

## Acceptance criteria

- [ ] It builds and runs on the iOS Simulator and an Android emulator
- [ ] A probe proves a plugin call from the bundle webview fails
- [ ] A channel message from another origin is dropped

When done, file a human test: on a phone, open the Demo Workstation from the hub, browse its board, and return to the hub, without anything opening a browser.
