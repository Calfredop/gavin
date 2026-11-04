---
complexity: complex
order: 16384
kind: plan
title: [ux] split table confusing
status: Done
---
The current session’s tab split logic is not very user friendly. Let’s say I am in a page, on session (a), and I press its file diffs button; a right split tab with the correct content shows up, as it should. The trouble is that if I switch session’s tab, the previous session right split keeps showing. I think opening a subtab, or splitting when another tab is present, should create a group. This needs to be handled in terms of ui because now the split panels are considered tabs

## Decided

Read `docs/adr/0013-a-view-belongs-to-the-tab-that-opened-it.md` and the **Pages** terms in `CONTEXT.md` (Attached view, Tab group) first.

- **Cause today.** Every "open beside" action calls `layout.splitLeaf` (`app/src/lib/panes/layout.ts:132`), which splits the WHOLE pane, so the view sits beside every tab in it. The callers are `openViewTabInSplit` (plan, changes, follow-ups chips), `openBrowserInSplit`, `openFileInSplit` and `openBoardInSplit` in `app/src/lib/core/layoutState.ts`, plus the Plan Explorer's "Open in split" (`PlanExplorerHubView.svelte:465`).
- **Attached views.** A view opened from terminal tab (a) belongs to (a). It is drawn as ONE side pane on the right, inside (a)'s pane, only while (a) is the active tab. The side pane has its own small tab strip (Plan | Changes | …). A second view opens as another tab there, and an open view of the same thing is brought forward instead. The de-duplication runs within (a)'s group, not across the page.
- **Terminals are never attached.** Split Right / Split Down stay page-level splits, unchanged.
- **Header.** The pane's tab bar and action row read (a), the tab that owns the group, wherever focus sits inside the group. From the diff you can press Show plan and get the plan. Attached views do not appear as tabs in the pane's main tab bar.
- **Marker.** A tab with attached views shows a small split glyph in the bar, with a tooltip naming them ("Plan · Changes").
- **Closing.** A close box on each view's tab in the side strip; one X at the end of that strip closes the whole side pane; the side pane disappears when its last view closes. Closing (a) closes its attached views. Close Pane closes everything, as today.
- **Chips toggle.** A chip is lit while its view is open. Pressing it while that view is in front closes the view; pressing it otherwise opens the view or brings it forward.
- **Detach by dragging only.** Dragging a view's tab out of the side strip into a pane, or onto a tab bar, makes it an ordinary tab that stays on screen whichever tab is active. There is no menu item.
- **Width.** The divider is remembered per group, saved with the layout, and starts at 50/50.
- **Old pages are left alone.** View panes split before this stay ordinary panes. Nothing is converted.
- **Out of scope.** The Companion (phone): it must only keep reading layouts that carry the new field.

Assumptions, not asked: a view opened while the active tab is itself a view (a file or board tab) falls back to today's page split. Nothing can be dropped INTO a side strip. The browser's automatic open (`focus: false`) attaches to its session's tab without taking focus.

## Checklist

- [x] Layout model: a leaf carries per-tab attached views (`{ tabs, activeTabIndex, size }` keyed by the owning tab id), kept through `normalizeLeaf` and pruned when the owner leaves `tabs`; pure helpers to attach, focus, close one, close all, detach, and resize. Unit-tested in `layout.test.ts`.
- [x] Rust mirror: `app/src-tauri/src/layout.rs` `LayoutNode::Leaf` carries the field (`serde(default, skip_serializing_if = empty)` so old state stays byte-identical); `all_session_ids` and the walks in `session.rs` / `config.rs` that prune or reconcile tab ids see attached ids; a round-trip test proves a saved group survives a Rust write.
- [x] Opens: every caller listed under "Cause today" attaches to the anchor tab instead of calling `splitLeaf`, with the fallback above; the de-duplication looks in the anchor's group; `pruneCardTabs` / `setFileTabs` / `setBoardTabs` still find attached ids, so no view tab is lost on relaunch. Unit-tested in `layoutState.test.ts`.
- [x] Closing: closing the owner closes its group; close-one, close-all and the chip toggle; Close Pane closes groups too.
- [x] Pane rendering: `Pane.svelte` draws the side pane (strip, divider, close boxes) only for the active tab; the header and action row follow the group's owner wherever focus sits inside it (`paneOwnsActions` and the `active` the chips read); the split glyph and tooltip on owners; logic in a `.ts` module, the template thin.
- [x] Drag out: a side strip tab dragged to a pane or a tab bar becomes an ordinary tab there (`dragDrop.ts` / `tabBarDropSurfaces`); dropping into a side strip is refused.
- [x] Checks green: `cargo test --workspace`, `cd app && npm test && npm run check && npm run build`, and `npm run companion:test && npm run companion:check`.
  Result (2026-11-04): app 8548 tests, check 0 errors, build ok; companion 933 tests, check 0 errors; `cargo test` green for every crate this touches (app_lib's one failure is the `git::watch` fs-watcher flake, 21/21 alone). `gavin-daemon` fails 4 under a temp HOME (`program::tests` flags committed `shell.rs:207`, two `server::tests`, `git_watch`) and `device_wire` 1 -- `crates/` is untouched here and does not depend on the app crate, so these are on main already.
- [ ] Human test: In a pane holding (a) and (b), open (a)'s diff, then switch to (b): the diff is gone and (b) fills the pane. Switch back: the diff returns at the width you left it. From the diff, Show plan opens the plan as a second tab beside it. Relaunch the app: same. Close (a): its views go with it.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
