---
kind: task
title: [ui] review tab group expansion
status: Done
---
Add an expand/collapse all control to the Review tab's card list, make
collapsed the default, and remember each group's open state and the
picked card as the human navigates away from the tab.

## What landed

**Groups are closed by default, and the OPEN set is what gets
remembered** (`reviewPrefs.expandedGroups`, per workspace, localStorage).
That polarity is the whole trick: a group's identity is its file set, so
its id retires whenever anything in the fleet writes to the checkout.
An id nobody recognises then falls back to closed — which is the default
anyway. Remembering the closed set instead would make every churned id
spring open, the opposite of a default.

**The id had to get short first.** It was the checkout plus every path in
the cluster joined by newlines: the group this tab was just fixed for
holds 230 of them, so writing that down would have put kilobytes of file
names into localStorage per group. It is now a 16-hex digest of the same
thing, so identity is unchanged and the record is one line.

**One control, not two.** A single button that reads the list: it offers
"expand every group" until they all are, then "collapse every group".
Disabled on an empty list, because a button that offers to close nothing
looks broken when pressed. `ChevronsUpDown` / `ChevronsDownUp`, both
added to theme.css's chevron sharpening and to the guard test that pins
it — an unsharpened chevron is blunt in silence with every suite green.

**Bounded, never pruned against the screen.** The record caps at
`MAX_REMEMBERED_GROUPS` (64), most recently opened first. Pruning to the
groups currently listed was the obvious alternative and is wrong: the
search box narrows the list, so pruning would quietly forget every group
the query happens to hide. For the same reason expand-all leaves hidden
groups' state alone rather than rewriting the whole record.

**The picked card already persisted** (`reviewPrefs.selected`, restored
through `resolveSelection` so a card filed or archived meanwhile does not
strand the view). Verified rather than re-implemented.

Logic in `reviewBoard.ts` with tests (`isGroupExpanded`,
`toggleExpandedGroup`, `everyGroupExpanded`, `setAllGroupsExpanded`);
`ReviewCardList.svelte` stayed a template over it and lost its local
`folded` state, which the hub was destroying on every tab switch anyway.

## Checks

`npm test` 4555 passed · `npm run check` 0 errors · `npm run build` green.
No Rust, no daemon, no protocol bump — localStorage only.

Left for the owner: the rendered pass — the new button's two states and
how a list of closed group headers reads as an overview.
