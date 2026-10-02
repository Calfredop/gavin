---
order: 27648
kind: task
title: Companion 28: rails and orchestration on the phone
status: Done
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

- [x] Seam 2 tests for rail actions, including one that proves the scheduler never starts in the bundle
- [x] The desktop orchestration suites still pass
- [ ] Human test: After rebuilding the desktop app from companion/phone: on the phone, open a workspace's Rails tab, press Start on an idle rail, and watch the desk's Orchestration tab launch its first step (and the phone show it running)

When done, file a human test: start a rail from the phone, and watch the desk run it.
