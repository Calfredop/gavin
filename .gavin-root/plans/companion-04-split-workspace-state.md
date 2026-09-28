---
kind: task
title: Companion 04: split workspace data from desktop layout
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (section "Workspace state split") and ADR 0003 first.

## What to build

A refactor that makes the later work easy, with no behaviour change for the desktop.

The desktop saves its workspace state as one blob that mixes two things:

- **Workstation data:** which workspaces exist, and each workspace's settings (auto commit, review gate, git tracking and the rest).
- **Desktop layout:** pages and tabs.

The Companion must be able to change workspace settings, but never the desk's layout. So split the saved state: workspace settings get commands of their own, and layout keeps the existing layout-saving commands. Every surface that changes a workspace setting moves to the new commands.

## Acceptance criteria

- [ ] Workspace settings save and load through the dedicated commands, and layout saving is unchanged
- [ ] A `config.json` written by the current build loads without loss (a test against a hand-built old-shape file)
- [ ] The release build, reading a `config.json` the new build wrote, still works: the dev and release builds share `config.json`
- [ ] Logic lives in a pure `.ts` module with unit tests, and the `.svelte` files stay thin
