---
order: 9216
title: Plan tree indentation
status: Done
priority: low
labels: ui
---
# Plan tree indentation

In the workspace Plans tab, nested contexts, group headers, and files all
share the same left edge, so the tree reads as flat. Indent each level so
nesting is evident.

- [x] `buildExplorerTree`: add `depth` to `ExplorerContextNode` (root = 0,
      nested contexts = 1 + nearest ancestor context's depth) + tests
- [x] `PlanTree.svelte`: inset rows per level — context at `depth`, group
      at `depth+1`, file at `depth+2`, composer aligned with groups
- [x] `npm test` + `svelte-check` pass (422 tests, 0 errors, no new
      warnings in the touched files)
