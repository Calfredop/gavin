---
title: IconButton primitive (SP2 of 4)
status: To Do
priority: medium
labels: ui
---
Depends on SP1 (consumes tier-2 tokens).

One `IconButton.svelte` replacing the ~6 divergent styles found in the
audit — `GitToolbar.svelte:193` `.icon` (bordered, r6), `TitleBar.svelte:142`
`.actions button` (filled, r3), `BoardCard.svelte:316` `.chevron` and `:385`
`.run` (bare, opacity-reveal), `KanbanColumn.svelte:474` `.run-all`
(bordered, r10), `Pane.svelte:556` `.new-tab`.

Also normalises the 8 ad-hoc lucide icon sizes (6/8/10/11/12/13/14/16)
and the three disabled-state opacities (0.4/0.45/0.5).

Needs its own spec before work starts.
