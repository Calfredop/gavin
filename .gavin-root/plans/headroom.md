---
order: 7168
title: Headroom agent tooling
status: To Do
labels: ready-for-agent
attachments: docs/superpowers/specs/2026-09-28-headroom-design.md,CONTEXT.md,docs/adr/0007-daemon-runs-headroom-not-wrap.md
complexity: intricate
---
Stretch the fleet's subscription limits by compressing what agents send to their model through [Headroom](https://github.com/headroomlabs-ai/headroom), and show what it saves from day one.

The human installs Headroom from Settings or the wizard, at a version Gavin has tested. Compression is on or off per workspace, with an app default that starts Off. Each daemon runs its own Headroom, and every agent it launches in a compressed workspace talks to its model through it: Claude Code, Codex, opencode, and Custom agents whose API family is named. Gemini waits on a spike, and Cursor cannot be routed at all. Plain shell tabs are left alone. Savings land per card run, per limit window in the hub, and as a lifetime total in Settings. A session that should have been compressed and was not is marked with the reason, and a broken Headroom never stops a rail.

**Spec:** `docs/superpowers/specs/2026-09-28-headroom-design.md`. Read it first.

**Decisions:** ADR 0007: the daemon runs Headroom, and Gavin wires agents to it itself, never through `headroom wrap`.

**Glossary:** `CONTEXT.md` (Integration, Agent tooling, Headroom, Compressed session).

Tickets are task cards nested under this plan, each with its own status and a `Blocked by:` first line. Rails sequence them. After 02 lands, 03, 04 and 05 can run in parallel.

- [ ] [headroom-01](headroom-01-daemon-runs-headroom.md): the daemon runs Headroom
- [ ] [headroom-02](headroom-02-compressed-launches-claude-code.md): compressed launches and Claude Code
- [ ] [headroom-03](headroom-03-codex-opencode-custom.md): Codex, opencode and Custom
- [ ] [headroom-04](headroom-04-setup-surfaces.md): the setup surfaces
- [ ] [headroom-05](headroom-05-savings.md): savings
- [ ] [headroom-06](headroom-06-honest-failures.md): honest failures
- [ ] [headroom-07](headroom-07-gemini.md): Gemini, after a spike
- [ ] [headroom-08](headroom-08-windows-and-intel-mac.md): Windows and Intel Macs (parked)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
