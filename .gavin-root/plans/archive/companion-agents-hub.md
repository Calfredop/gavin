---
kind: task
title: Companion Agents hub
parent: feat-rework-agent-s-settings.md
complexity: moderate
---
Give Companion the same Agents hub as the desk: PhoneAppSettings and
PhoneWorkspaceSettings get one Agents area with the same tab set and
Customs CRUD (app-wide vs workspace-local), backed by the new profile
model — not a second parallel settings IA.

Reuse desktop components where the Companion seam already does
(ComplexityTable, FallbackChainEditor, etc.); add Customs / tab shell the
same way. Keep phone layout constraints from companion README (touch
targets, stacking).

## Verify
- Companion tests/seam lists cover the new settings actions.
- Demo workstation can exercise Agents tabs and named customs.
