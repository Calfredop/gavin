---
order: 27648
kind: task
title: Companion 28: rails and orchestration on the phone
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: companion-23-served-signed-ui.md

Part of `companion.md`. Read the spec (section "Forwarding to the desktop app": the Companion never starts the scheduler) first.

## What to build

In the bundle, made responsive:

- each rail's state, and starting, resuming or pausing a rail;
- editing orchestration.

The Companion never ticks rails: starting a rail arms it, and the desk's scheduler runs it. Extend the Demo Workstation to match.

## Acceptance criteria

- [ ] Seam 2 tests for rail actions, including one that proves the scheduler never starts in the bundle
- [ ] The desktop orchestration suites still pass

When done, file a human test: start a rail from the phone, and watch the desk run it.
