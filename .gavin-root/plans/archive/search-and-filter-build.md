---
title: Search & filter — build
status: Done
priority: high
---
# Search & filter — build

Implementation checklist for the task card `search-and-filter.md`: a search
box on the Kanban board, the Orchestration tab (rails + unplaced pool), the
Plans tab (plus rail and status facets) and the Git tab.

## Design

One pure matcher (`search.ts`: whitespace-split tokens, every token must
appear in some field, case-insensitive) under four surface-specific
projections, each with its own vitest file. One shared `SearchInput`
component so every surface looks and behaves the same (⌘-less: type to
filter, Esc clears, an ✕ button, a `shown/total` count).

Filtering is a **lens**: while a query is active the Kanban board and the
Orchestration rails do not accept drags (a drop index measured over
filtered DOM would write the wrong `order`), and column delete/clear are
disabled. The search bar says so.

## Steps

- [x] `search.ts` — tokenizer + field matcher + `filterList`, with tests
- [x] `ui/SearchInput.svelte` — shared box (icon, clear, count, Esc)
- [x] `boardSearch.ts` — filter the merged board projection, with tests
- [x] Kanban: search bar in `KanbanBoard` + `BoardPane`, per-column `n/total`, drag lock
- [x] `orchestrationSearch.ts` — rail / step / unplaced-pool matching, with tests
- [x] Orchestration: header search, rail hiding, chip dimming, drawer filter
- [x] `planFilter.ts` — explorer tree filter with status + rail facets, with tests
- [x] Plans: search + status and rail dropdowns over the context tree
- [x] Git: changed-files search (staged/unstaged/stash) with scoped Stage/Unstage
- [x] Git: ref search in the nav (branches, remotes, stashes) + reuse the box in the commit graph
- [x] Smoke checklist entries, `npm run test` + `npm run check` green
- [ ] Manual smoke pass
