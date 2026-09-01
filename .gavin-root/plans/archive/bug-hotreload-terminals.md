---
order: 1024
kind: task
title: [bug] hotreload terminals
status: Done
---
Hot reloading app makes the terminals tabs in workspace’s tab and hub go black.
We already did two iterations on this issue, but the bug persists. If there's a split terminal tab, then each tab of a page is a black space, that shows nothing. So the issue is the split state.
## What it was

One line of CSS, in a component that has nothing to do with terminals.

`PlanTree.svelte` styles the little "open beside a terminal" button on each file
row. That button is an `<IconButton>`, so the class is handed over as a prop and
lands on *IconButton's* element — Svelte's scoping class never reaches it, and
only `:global` can. The rule was written bare:

```css
:global(.add),
:global(.split) { margin-left: auto; opacity: 0 }
```

A `:global(...)` at the START of a selector is not a component rule at all. It is
an app-wide rule that happens to live in a component's `<style>`, and this one
matched every `.split` in the window — including `LayoutTree.svelte`'s split
*container*, the box every pane of a split page lives in. It drew it at
`opacity: 0`.

So any page whose layout had a split rendered nothing: correct geometry, correct
tab bars, all invisible, leaving only the sidebar and the title bar. A board tab
counts, because `openBoardInSplit` opens one. Closing the split removed the
element and the page came back — which is exactly what the report described.

The hot reload was a red herring. The rule ships in the bundle too;
`PlanExplorerHubView` is statically imported by `workspaceViews.ts`, so
PlanTree's stylesheet is in the document from the first frame whether or not the
Plans tab was ever opened. Hot reloading was just when the splits happened to be
looked at.

Two prior iterations went past it because both looked at the terminal: the daemon
screen snapshot (PROTOCOL 18) and `hotState` carrying the registry across a
module re-execution. Both are right and both stay. The terminal was never the
thing that was broken — measured through a hot reload in an isolated instance,
every `Terminal`, container and listener survives correctly.

## How it was found

An isolated app instance (own `$HOME`, own daemon, driven by a temporary
command-file harness) with a probe writing DOM geometry *and computed styles* to
a file on every re-render. Geometry alone said "healthy" for hours; the first
sample that included `getComputedStyle` read
`split0: 799x660 flex/visible/0/...` — sized, laid out, `opacity: 0`.

## What changed

- `PlanTree.svelte` — the two rules are anchored to the component's own scoped
  rows: `.context-row :global(.add)`, `.file-row :global(.split)`.
- `BoardCard.svelte` (`:global(.chevron)`) and `KanbanColumn.svelte`
  (`:global(.run-all)`) had the same unanchored shape. Neither collides with
  anything today, but `.chevron` and `.run-all` are exactly as generic as
  `.split`; both are now anchored to their `.header`.
- `globalStyleScope.test.ts` — a static guard: no component may begin a selector
  with `:global(`, except a hand-listed pair of deliberate app-wide resets
  (xterm's own DOM, and the `html, body` / text-input selection reset). It names
  the offenders in the failure, because the whole trap is that the rule and the
  element it breaks live in different files. Verified by reintroducing the bug:
  it fails and names `.add` and `.split`.

Confirmed live: `.split` went from `opacity: 0` to `1` in the running app the
moment the fix hot-reloaded.
