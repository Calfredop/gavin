---
kind: task
title: Companion 26: terminals on the phone
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md, companion-01-typing-prototype.md

Part of `companion.md`. Read the spec (section "The Workstation UI bundle", the typing point), ticket 01's findings, and ADR 0005 first.

## What to build

In the Companion bundle, sharing responsive components with the desktop:

- the sessions list and a live terminal view, on xterm.js 6.1 for touch scrolling;
- typing per ticket 01's outcome: a compose field with quick replies derived from the turn verdict, plus a raw mode with a special-key row, unless ticket 01 changed that;
- killing a session and opening a new one.

Extend the Demo Workstation with sessions.

## Acceptance criteria

- [ ] Seam 2 tests: compose sends the line plus Enter, quick replies come from a verdict, and raw-mode keys map to the right bytes
- [ ] The desktop's terminal surfaces still pass their suites (upgrading xterm touches the desktop too)

When done, file a human test: on a phone, answer a waiting agent with a quick reply, then type in raw mode, and scroll back through the history.
