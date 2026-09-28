---
kind: task
title: Companion 30: settings, workspace settings and adding a workspace on the phone
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md, companion-04-split-workspace-state.md

Part of `companion.md`. Read the spec (section "Workspace state split") first.

## What to build

In the bundle, made responsive:

- app settings and agent configuration;
- workspace settings, through ticket 04's commands;
- **adding a workspace**, through a remote folder browser built on the file viewer's directory listing, starting at the home folder.

Extend the Demo Workstation to match.

## Acceptance criteria

- [ ] Seam 2 tests for the settings and add-workspace flows
- [ ] Seam 1: the Remote role may call the workspace-settings commands but not the layout-saving ones

When done, file a human test: add a workspace from the phone, and see it appear at the desk.
