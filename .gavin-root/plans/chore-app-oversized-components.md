---
title: Hold the thin-template rule on the six components that broke it
status: Done
priority: low
complexity: complex
---
`CLAUDE.md` states the rule: *"Logic goes in a plain `.ts` module with unit tests
(`orchestration.ts`, `sidebarSummary.ts`, `planBoard.ts`, …); the `.svelte` file
stays a thin template over it."* The repo mostly keeps it — ~185 pure `.ts`
modules with 218 test files beside them, and not one dead module. Six components
do not:

| file | total | `<script>` | `<style>` | markup |
|---|---|---|---|---|
| `Sidebar.svelte` | 2553 | **1038** | 705 | 810 |
| `CardDetailModal.svelte` | 2432 | **1075** | 713 | 644 |
| `SettingsHubView.svelte` | 1668 | **729** | 148 | 791 |
| `OrchestrationHubView.svelte` | 1360 | **707** | 208 | 445 |
| `Pane.svelte` | 1110 | **566** | 236 | 308 |
| `KanbanBoard.svelte` | 851 | **463** | 158 | 230 |

(`routes/+page.svelte` is 905 lines for a three-file route folder and belongs in
the same conversation.)

A thousand lines of `<script>` is a thousand lines the suites cannot reach —
which matters more here than in most codebases, because the rendered surface is
WKWebView with no harness and a static pre-flight is the only automated check
there is. Every line that moves into a `.ts` becomes a line a test can hold.

## Steps

- [x] Land `chore-app-lib-flat-directory.md` first. Splitting a component adds
      files; adding them to a 506-entry flat folder and then moving them twice is
      wasted motion.
- [x] For each of the six, name what the `<script>` actually does before cutting:
      derived view state, event wiring, and one-shot effects are three different
      things and only the first extracts cleanly.
- [x] Extract per component into a sibling `.ts` with tests, following the shape
      `sidebarSummary.ts` / `planBoard.ts` / `orchestration.ts` already set —
      pure functions over data in, view model out.
- [x] Leave the `<style>` blocks alone. `AppHubView.svelte` is 788 lines of style
      against 401 of script; that is a component doing its job, not a violation.
- [x] `cd app && npm test && npm run check && npm run build` after each component,
      not once at the end.

## Survey (what each `<script>` actually does)

Named before cutting, per the step above. Three kinds of code, and only
the first extracts cleanly:

| component | derived view state | event wiring | one-shot effects |
|---|---|---|---|
| `KanbanBoard` | card flattening, delete-prompt lines, two-lens hidden count, column composer | run/resume/develop/restore/send, two context menus, drag commit | fetch, deep link, focus refetch, facet prune, ⌘N, drag attach |
| `Pane` | tab kind, label, tooltip, renameable, three badges, reverse card lookups | split, close, rename, six drag handlers | fetch, repair unknown tabs, focus edit, ResizeObserver |
| `OrchestrationHubView` | four prompt bodies, two header tips, conflict summaries, move-all menu, drop routing | eight rail actions, two agent hand-offs | fetch board/plan/tools/templates/git, deep link, drag attach |
| `SettingsHubView` | six commit rules, three blocked reasons, inherited values | fifteen field commits, two pickers, restart, install | eight draft-follows-store, two token-guarded reads |
| `CardDetailModal` | the situation precedence, three badges, review gate, two fold summaries | eight run actions, rail send, archive, adopt, delete | watched file read, attachment stat, scroll reset |
| `Sidebar` | five tooltips, tab labels, four recaps, hints, expansion | rename x3, nine drag handlers, three menus | peek listeners, auto-expand, recap fetch, focus edit |

Only the first column moved. Event wiring stays: it is a handler calling
an action and reporting an error, and pulling it out buys a test of the
harness. One-shot effects stay too — `$effect` is where the reactivity
IS, and a pure function that had to be called from one anyway is the
same code one file further away.

## What landed — one commit per component

- **`KanbanBoard`** — `flattenCardViews` (planBoard), `cardDeleteLines`
  (cardDelete), `hiddenAcross` (boardSearch), `columnComposer.ts`.
  `ReviewHubView` had a third spelling of the flattening and now shares
  it.
- **`Pane`** — `panes/tabIdentity.ts` (kind / label / tooltip /
  renameable), `tabAgentIndicator` (indicators), `reorderIndexWithin`
  (dragDrop). Caught a real bug: the repair effect's filter left the card
  map out, so every card tab was queued as an unknown tab.
- **`OrchestrationHubView`** — `orchestrationDrop.ts` (five drag kinds ×
  three targets, and the groups gate in front of them),
  `finishedRailDoneCards`, `railMoveAllEntries`, `conflictSummaryLines`
  (orchestration), `runAllTip` / `clearFinishedTip` (railConfirm).
- **`SettingsHubView`** — `fieldCommit` and `deleteBlockedReason`
  (settings), `modelIsCustom` (agentModel). Six handlers, three different
  answers to "the human cleared this box", none of them reachable before.
- **`CardDetailModal`** — `cardSituation` and `primaryAction` and
  `boundStatusLabel` (cardDetail), `cardNeedsReview` (cardReview),
  `adoptBlockedReason` (memoryCard). One precedence chain that had three
  spellings is now one, read three times.
- **`Sidebar`** — `sidebar/sidebarTips.ts` (the only words a 200px column
  has). `tabRowLabel` was a second implementation of the tab bar's naming
  under a comment promising there was only one; it calls `tabIdentity`
  now.
- **`routes/+page.svelte`** (the seventh, as the card asked) —
  `drawableHubViewId` and `keepableHubViewIds` (hubViewMeta),
  `shell/windowChrome.ts`, `computeReorderPositionX` (dragDrop).

Script lines: 1038 → 945, 1075 → 1069, 729 → 722, 707 → 699, 566 → 512,
463 → 461, 320 → 316. The count barely moved and that is the honest
result — what came out was the branching, not the bulk. 24 new pure
functions, 116 new unit tests, and eight static pre-flight guards
re-aimed from the text that moved onto the module that now holds it, so
each one pins the WIRING while a unit test holds the rule.

`cargo test --workspace` was not run: nothing outside `app/` changed.

## Notes

- Six separate commits, one per component. A single commit spanning all six is
  unreviewable and unrevertable.
- Svelte 5 `$state` proxies objects, so `stateVar !== rawObject` is always true —
  extracted logic must not gate on identity, and async supersession needs a token
  counter.
- This is the one card here that changes behaviour if done carelessly. Nothing on
  it is urgent; it is worth doing only where the extraction makes something
  testable that is not testable now.
