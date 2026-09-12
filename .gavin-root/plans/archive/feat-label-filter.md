---
title: Filter the board by label, including not
status: Done
complexity: moderate
---
Tag Windows-related cards with `windows`, then add a fourth board facet that can include or exclude a label.

- [x] Failing tests for label / not-label in `boardFilters.ts` (pass, AND with other facets, prune, nested children)
- [x] Implement the facet in `boardFilters.ts` and the fourth dropdown in `FacetFilters.svelte` (Kanban, Review, Plans, archive)
- [x] Surface tests for the new copy; hubFacets / callers compile with the new field
- [x] Add the `windows` board label and write `labels: windows` on the agreed Windows cards
- [x] Verify: `npx vitest run` on the touched tests; `npm run check`; static pre-flight of the dropdown copy
