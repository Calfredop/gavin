---
title: Workspace init wizard
kind: plan
status: To Do
priority: medium
labels: ui
---
# Workspace init wizard

Two-stage onboarding for a new workspace: a creation modal for the folder
and fundamental settings, then a guided wizard for agent setup.

**Blocked on** the multi-agent MCP writers — the wizard's Integration step
cannot complete for Codex/Gemini/Cursor/opencode until those exist, and
the owner chose to build them first rather than ship a wizard that
degrades for four of six profiles.

## Decisions taken in brainstorming (2026-08-21)

- **W1 — Skippable and resumable.** Closing the wizard at any step leaves
  the workspace usable; the Home tab offers to finish setup. Progress is
  **derived from disk** (root bound? agent file present? .mcp.json
  written?), never stored, so a step done by hand already counts.
- **W2 — Four steps:** Agent (profile + command) → Integration
  ({agent}.md + skill + MCP config, one action) → PRD → Launch. Launch is
  optional and last: it is the only step that costs money, so it stays a
  deliberate press (upholds D12, nothing starts on its own).
- **W3 — The PRD step prompts for the template's three sections**
  (Vision / Current focus / Out of scope) and writes them into the
  existing `PRD.md` structure. Blank fields keep the placeholders.
- **W4 — Sub-project B lands first**, so every profile's Integration step
  can actually complete.

## Still open

- Whether step 1's modal embeds the Settings panel's components or
  carries its own fields.
- Whether the wizard is offered for existing unrooted workspaces or only
  brand-new ones.
