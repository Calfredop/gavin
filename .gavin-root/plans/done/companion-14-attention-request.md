---
kind: task
title: Companion 14: the attention request
status: Done
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: companion-13-desktop-answers-forwarded.md

Part of `companion.md`. Read the spec (section "The attention request") and ADR 0005's "The one stable API" first.

## What to build

The one deliberately stable API between the shell and a Workstation. It is a small, versioned request a Device sends. The daemon asks the desktop app, which answers from where the signals live (the attention inbox, the turn verdict, the rails) with two things:

- **The Workstation's state.**
- **The waiting items:** an agent waiting on the human, a human test filed, an agent failed or interrupted, a rail stopped. Each carries an id, a workspace, a kind, a short text and a target (a session or a card).

The request carries an explicit version, and it only ever grows by optional fields.

## Acceptance criteria

- [x] Seam 1: the test Device gets the items the stand-in reports, and the "desktop app not running" state when it is absent
- [x] The desktop's answer is built by a pure module, unit-tested from inbox, verdict and rail state
- [x] An older reader ignores an unknown optional field
