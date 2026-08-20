---
title: Workspace settings panel
status: To Do
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

Spec approved 2026-08-20; implementation plan not yet written.
