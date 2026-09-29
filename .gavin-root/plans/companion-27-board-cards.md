---
order: 26624
kind: task
title: Companion 27: board and cards on the phone
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md, companion-16-presence-and-phone-sessions.md

Part of `companion.md`. Read the spec (section "The Workstation UI bundle") first. Mind the traps in `CLAUDE.md` on nested-task status (always go through `effectiveStatus`) and on Svelte 5 proxies.

## What to build

The board, made responsive in the bundle, with every card action:

- move cards, tick checklist items, file and rename cards;
- **Run card**: the session opens as a labelled tab at the desk (ticket 16);
- answer decisions, and pass or fail human tests;
- archive, and read the PRD.

Extend the Demo Workstation to match.

## Acceptance criteria

- [ ] Seam 2 tests for each action's channel traffic
- [ ] The desktop board's suites still pass

When done, file a human test: from the phone, run a card and see a labelled tab at the desk; then pass a human test from the phone.
