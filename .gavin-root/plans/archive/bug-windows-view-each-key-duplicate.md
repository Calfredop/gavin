---
order: 7168
title: [bug] Windows main view crashes with each_key_duplicate
status: Done
priority: high
complexity: moderate
labels: windows, bug
---
Reported against a Windows install: the workspace content area (the `<svelte:boundary>` in `app/src/routes/+page.svelte`) shows

> This view couldn't be drawn
> https://svelte.dev/e/each_key_duplicate

That error means a keyed `{#each … (key)}` produced the same key for two items. The boundary wraps every non-app-hub surface: Home, Kanban, Git, Orchestration, Plans, Files, Decisions, Review, Settings, and Terminal. A production build only prints the svelte.dev URL, so the boundary now also names the active view in the detail line and the console payload.

## Cause found (Home default)

Home is the default view for a workspace with a root. Its board recap keyed columns by `column.name`. Add/rename never refuse a duplicate spelling, so two columns named "To Do" throw `each_key_duplicate` and blank the content area. The phone board already keys on `column:${id}` for the same reason.

Fix: `boardSummary` carries each column's `id`; Home keys `(column.id)`.

Also hardened nearby keyed eachs that can throw the same error: BoardCard label chips (dedupe names), git graph `outgoing` lanes (dedupe repeated parent SHAs), and oversize plan paths on Windows (`wire_path` instead of `to_string_lossy`).

## Checklist

- [x] Infer the crashing surface: Home is the default for a rooted workspace and keyed columns by name
- [x] Fix Home to key columns by id; harden label chips, graph outgoing lanes, oversize plan wire paths
- [x] Regression tests in homeSummary / homeHubLayout / graphLanes / viewBoundary
- [ ] Human test: on the Windows machine, open the same workspace on Home — the content area draws without the boundary fallback; if it still fails, note the view name now shown in the error detail
- [ ] Decision: Which view is selected when the content area shows each_key_duplicate?
  Options: A) Home (default) B) Kanban C) Git D) Orchestration E) Plans / Files / PRD F) Decisions / Review G) Settings H) Terminal I) Every hub tab / unknown
- [ ] Human test: on the Windows machine, open the same workspace on Home — the content area draws without the boundary fallback; if it still fails, note the view name now shown in the error detail
