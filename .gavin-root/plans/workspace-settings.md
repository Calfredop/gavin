---
title: Workspace settings panel
status: In Progress
priority: high
---
# Workspace settings panel

Per-workspace Settings hub tab: name, colour, root folder, notification
toggles, and the coding agent (profile, launch command, instructions-file
name — de-hardcoding CLAUDE.md).

Sub-project A of two. B is the multi-agent MCP writers (Codex TOML,
opencode, Gemini, Cursor) and the guidance question for agents with no
native skill mechanism.

- Spec: docs/superpowers/specs/2026-08-20-workspace-settings-design.md
- Decisions: D35–D43, logged in the spec's §2
- Protocol: bumps PROTOCOL_VERSION 6 → 7 (SetRootConfigField)
- New dep: toml_edit in the daemon (already transitively present)

- Plan: docs/superpowers/plans/2026-08-20-workspace-settings.md (7 tasks)

All 7 tasks implemented and committed (09cb355..4c8bc4a). Automated
verification green: cargo 308, vitest 463, svelte-check 0 errors, build
clean. Remaining before Done: the owner's interactive smoke pass — the
in-app Checklist tab's "Workspace settings" section (14 items), which
needs `pkill gavin-daemon` first because this bumps the protocol to v7.
