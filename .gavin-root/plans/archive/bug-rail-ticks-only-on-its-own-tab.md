---
kind: task
title: [bug] A rail only advances while the Orchestration tab is on screen
status: Done
---
Found while fixing the Commit tool card, and deliberately left out of that fix
because it is a separate fault affecting every kind of step.

`tick(workspaceId)` is called from exactly one place that fires on its own:
the `$effect` in `OrchestrationHubView.svelte`. `+page.svelte` renders hub
views one at a time (`<activeViewDef.component …/>`), and `activeView ===
"terminal"` renders `TerminalView` INSTEAD of the hub tabs at all. So the
scheduler runs only while the Orchestration tab is the active view.

Start a rail, then go watch the agent work on its page — which is the natural
thing to do — and nothing advances. The step's session exits (or its agent
goes idle), the code lands in `sessionExits` and the status in
`sessionStatusById` because those listeners are global in `layoutState`, but
no tick reads them until the human navigates back to the Orchestration tab,
at which point it all catches up at once.

It is self-healing, which is why it has stayed hidden. It is still a rail that
does not run while you are looking at what it is running.

The state is all available from a page: `Pane.svelte` already calls
`fetchOrchestration`. What is missing is a trigger that does not depend on one
component being mounted. Note `layoutState` cannot import `orchestrationState`
(the dependency runs the other way), so this wants either a subscription set up
inside `orchestrationState` itself — `layoutState.ts` already uses that idiom
at module scope with `gavinTrees.subscribe` — or a tick from a component that
is always mounted.

Watch out for: ticking every loaded workspace rather than only the active one
is a behaviour change in its own right, and `runTick` bails without a board, so
whatever fires it must not assume the board is loaded.
