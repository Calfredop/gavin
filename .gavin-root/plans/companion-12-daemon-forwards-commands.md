---
kind: task
title: Companion 12: the daemon forwards gated commands
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-11-connect-ik-unlock.md, companion-05-hello-connection-kind.md

Part of `companion.md`. Read the spec (sections "The shared protocol crate" and "Forwarding to the desktop app") and ADR 0003 first.

## What to build

The Remote role becomes useful.

- **The command table.** Put the Remote role command table in the protocol crate: every desktop command name maps to allowed or refused.
  - **Refused:** Trust (pairing, revoking, remote-access settings), the layout-saving commands, window management, the updater, opening things externally on the desk.
  - **Allowed:** everything else.
- **The forwarding connection.** The desktop app opens it, marked as such in `Hello` (ticket 05 added the field).
- **Forwarding.** The daemon checks each command a Device sends against the table. It forwards allowed ones to the desktop app, returns the result, and relays events to the Devices that subscribed. With no desktop app connected, it answers "desktop app not running".
- **Compatibility.** Bump the protocol, with `min_version_for` arms.

## Acceptance criteria (seam 1, with a scripted desktop stand-in)

- [ ] An allowed command reaches the stand-in, and its result returns
- [ ] Trust and layout-saving commands are refused before any forwarding
- [ ] An unknown command name is refused
- [ ] Events reach only the Devices that subscribed
- [ ] "desktop app not running" is answered when the stand-in is absent
