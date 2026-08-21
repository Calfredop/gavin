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

Ships before the multi-agent MCP writers: the Integration step degrades
honestly for profiles that have no MCP support yet (W4).

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
- **W4 — Integration degrades honestly.** `setup_agent_integration`
  splits so the agent-file block is written for ANY profile; the skill
  file and MCP config are skipped with a named reason when the profile
  has no `McpLayout`. Agents without a skill mechanism get the guidance
  inline in the block.
- **W5 — Agent-driven authoring for both documents.** The PRD and
  agent-file steps each offer "I'll write it" or "ask the agent";
  choosing the agent starts the session on that step, one deliberate
  press, so D12 holds. The Launch step then reports it already running.

## Still open

- Whether step 1's modal embeds the Settings panel's components or
  carries its own fields.
- Whether the wizard is offered for existing unrooted workspaces or only
  brand-new ones.
