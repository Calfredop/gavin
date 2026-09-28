---
order: 7424
kind: task
title: Headroom 08: Windows and Intel Macs
status: To Do
labels: needs-triage
parent: headroom.md
complexity: moderate
---
Blocked by: windows-desktop-pass.md, headroom-04-setup-surfaces.md, upstream headroomlabs-ai/headroom#3749

Part of `headroom.md`. Read the spec (section "Platforms") first.

Parked. v1 shows Unavailable on Windows and Intel Macs.

- **Intel Macs.** Headroom's docs disagree about native builds for Intel Macs: the installation guide lists them, and the README says use Docker (#941).
- **Windows.** Headroom has an open Windows proxy outage (#3749), and Gavin's Windows desktop pass is not done.

Re-triage when both blockers clear. Establish what installs natively on each platform at the pinned version, then lift Unavailable where it does. On Windows that includes the detection paths (uv's tool directory there), Headroom's log file permissions (0600 on Unix, unrestricted on Windows), and the named-pipe daemon's child-process handling.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
