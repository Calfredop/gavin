---
order: 6144
title: Hold the thin-template rule on the six components that broke it
status: To Do
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

- [ ] Land `chore-app-lib-flat-directory.md` first. Splitting a component adds
      files; adding them to a 506-entry flat folder and then moving them twice is
      wasted motion.
- [ ] For each of the six, name what the `<script>` actually does before cutting:
      derived view state, event wiring, and one-shot effects are three different
      things and only the first extracts cleanly.
- [ ] Extract per component into a sibling `.ts` with tests, following the shape
      `sidebarSummary.ts` / `planBoard.ts` / `orchestration.ts` already set —
      pure functions over data in, view model out.
- [ ] Leave the `<style>` blocks alone. `AppHubView.svelte` is 788 lines of style
      against 401 of script; that is a component doing its job, not a violation.
- [ ] `cd app && npm test && npm run check && npm run build` after each component,
      not once at the end.

## Notes

- Six separate commits, one per component. A single commit spanning all six is
  unreviewable and unrevertable.
- Svelte 5 `$state` proxies objects, so `stateVar !== rawObject` is always true —
  extracted logic must not gate on identity, and async supersession needs a token
  counter.
- This is the one card here that changes behaviour if done carelessly. Nothing on
  it is urgent; it is worth doing only where the extraction makes something
  testable that is not testable now.
