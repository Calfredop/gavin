---
order: 28672
kind: task
title: Companion 29: Git and files on the phone
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md

Part of `companion.md`. Read the spec (section "The Workstation UI bundle") first.

## What to build

In the bundle, made responsive:

- the Git tab: status, diffs, commit, branches, merge, push;
- files: browse, read, edit.

Extend the Demo Workstation to match.

## Acceptance criteria

- [ ] Seam 2 tests for the Git and file actions' channel traffic
- [ ] The desktop Git and file suites still pass

When done, file a human test: commit and push from the phone, and edit a file from the phone.
