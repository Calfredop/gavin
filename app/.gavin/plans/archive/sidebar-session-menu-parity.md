---
title: Sidebar session row menu = tab menu
status: Done
---
Executing `.gavin-root/plans/contextual-actions-for-session.md`: a right-click
on a tab row inside an expanded page in the sidebar must offer the same menu
the tab bar offers, instead of today's three-item Jump / Open cwd / Close.

The tab menu's builder (`tabMenu.ts`) is already pure and kind-aware, so the
sidebar reuses it rather than growing a second copy. Two things stand in the
way: two of the actions it fires are hard-wired to the ACTIVE page, and the
sidebar has no inline rename for a session row.

- [x] `layoutState`: make `setTabPinned` / `splitPane` act on the page that
      actually owns the session, not `activePageLocation`. Today a pin or a
      split aimed at an off-screen page silently no-ops (the tree lookup
      misses and the unchanged tree is re-persisted). No-op for the tab bar,
      which only ever addresses the active page.
- [x] `splitPane` switches to the session's page: the split spawns a session
      and focuses it, so it must be on screen. Again a no-op for the tab bar.
- [x] `sidebarMenu.buildSessionRowMenuEntries`: take the owning leaf's tabs +
      pinned prefix and the row's kind/path, delegate to
      `buildTabMenuEntries`, and keep "Jump to Session" on top as the one
      sidebar-only affordance. "Open cwd in Finder" folds into the tab menu's
      "Open Folder in Finder" — same action, one label.
- [x] `Sidebar.svelte`: resolve the leaf via `findLeafPath`/`getNodeAtPath`
      on the row's own page, map `PageTabRow.kind` ("session") to the tab
      menu's `"terminal"`, and pass the right path per kind (file path /
      context folder / cwd).
- [x] Inline rename on a sidebar tab row, mirroring the workspace and page
      rename inputs already there, so "Rename…" has somewhere to land.
- [x] Unit tests for all of the above; `npm test && npm run check && npm run build`.
