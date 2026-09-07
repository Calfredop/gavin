export type Direction = "row" | "column";

export type LayoutNode =
  | { type: "leaf"; tabs: string[]; activeTabIndex: number; pinned?: string[] }
  | { type: "split"; direction: Direction; children: LayoutNode[]; sizes: number[] };

export type Leaf = Extract<LayoutNode, { type: "leaf" }>;

// Pinned tabs live as a PREFIX of `tabs` (browser-style). Every mutation
// funnels through this so the invariant holds: pinned ids not in `tabs`
// are dropped, pinned tabs are moved first keeping their relative order,
// the active tab stays active, and an empty `pinned` is omitted so state
// written before pinning existed stays byte-identical.
export function normalizeLeaf(leaf: Leaf): Leaf {
  const pinned = (leaf.pinned ?? []).filter((id) => leaf.tabs.includes(id));
  const pinnedSet = new Set(pinned);
  const activeId = leaf.tabs[leaf.activeTabIndex];
  const tabs = [...leaf.tabs.filter((t) => pinnedSet.has(t)), ...leaf.tabs.filter((t) => !pinnedSet.has(t))];
  const activeTabIndex = Math.max(0, tabs.indexOf(activeId));
  const orderedPinned = tabs.filter((t) => pinnedSet.has(t));
  return orderedPinned.length > 0
    ? { type: "leaf", tabs, activeTabIndex, pinned: orderedPinned }
    : { type: "leaf", tabs, activeTabIndex };
}

function updateLeafOf(tree: LayoutNode, tabId: string, update: (leaf: Leaf) => Leaf): LayoutNode {
  const path = findLeafPath(tree, tabId);
  if (!path) return tree;
  return replaceAtPath(tree, path, (node) => (node.type === "leaf" ? update(node) : node)) ?? tree;
}

export function isPinned(tree: LayoutNode, tabId: string): boolean {
  const path = findLeafPath(tree, tabId);
  if (!path) return false;
  const node = getNodeAtPath(tree, path);
  return node.type === "leaf" && (node.pinned ?? []).includes(tabId);
}

export function pinTab(tree: LayoutNode, tabId: string): LayoutNode {
  return updateLeafOf(tree, tabId, (leaf) => normalizeLeaf({ ...leaf, pinned: [...(leaf.pinned ?? []), tabId] }));
}

export function unpinTab(tree: LayoutNode, tabId: string): LayoutNode {
  return updateLeafOf(tree, tabId, (leaf) =>
    normalizeLeaf({ ...leaf, pinned: (leaf.pinned ?? []).filter((id) => id !== tabId) })
  );
}

// Target index for a reorder, measured in the array AFTER the moving tab
// is removed (which is how moveTabWithinLeaf splices). A pinned tab may
// only land inside the pinned block, an unpinned one only after it.
export function clampReorderIndex(leaf: Leaf, tabId: string, targetIndex: number): number {
  const pinned = leaf.pinned ?? [];
  const pinnedCount = leaf.tabs.filter((t) => pinned.includes(t)).length;
  if (pinned.includes(tabId)) return Math.max(0, Math.min(targetIndex, pinnedCount - 1));
  return Math.max(pinnedCount, Math.min(targetIndex, leaf.tabs.length - 1));
}

// Which tabs "Close Others" / "Close to the Right" / "Close to the Left"
// act on: never the clicked tab, never a pinned one.
export function bulkCloseTargets(
  tabs: string[],
  pinned: string[],
  tabId: string,
  mode: "others" | "right" | "left"
): string[] {
  const index = tabs.indexOf(tabId);
  if (index === -1) return [];
  const candidates = mode === "others" ? tabs : mode === "right" ? tabs.slice(index + 1) : tabs.slice(0, index);
  return candidates.filter((id) => id !== tabId && !pinned.includes(id));
}

export function findLeafPath(node: LayoutNode, sessionId: string, path: number[] = []): number[] | null {
  if (node.type === "leaf") {
    return node.tabs.includes(sessionId) ? path : null;
  }
  for (let i = 0; i < node.children.length; i++) {
    const found = findLeafPath(node.children[i], sessionId, [...path, i]);
    if (found) return found;
  }
  return null;
}

export function getNodeAtPath(node: LayoutNode, path: number[]): LayoutNode {
  let current = node;
  for (const index of path) {
    if (current.type !== "split") throw new Error("path descends into a leaf");
    current = current.children[index];
  }
  return current;
}

export function isLastTabInPane(tree: LayoutNode, sessionId: string): boolean {
  const path = findLeafPath(tree, sessionId);
  if (!path) return false;
  const leaf = getNodeAtPath(tree, path);
  return leaf.type === "leaf" && leaf.tabs.length === 1;
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, s) => sum + s, 0);
  return total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / sizes.length);
}

function replaceAtPath(
  node: LayoutNode,
  path: number[],
  updater: (target: LayoutNode) => LayoutNode | null
): LayoutNode | null {
  if (path.length === 0) {
    return updater(node);
  }
  if (node.type !== "split") {
    throw new Error("path descends into a leaf");
  }
  const [index, ...rest] = path;
  const updatedChild = replaceAtPath(node.children[index], rest, updater);

  if (updatedChild === null) {
    const children = node.children.filter((_, i) => i !== index);
    const sizes = node.sizes.filter((_, i) => i !== index);
    if (children.length === 1) {
      return children[0];
    }
    return { ...node, children, sizes: normalizeSizes(sizes) };
  }

  const children = node.children.map((child, i) => (i === index ? updatedChild : child));
  return { ...node, children };
}

export function splitLeaf(
  tree: LayoutNode,
  targetSessionId: string,
  direction: "row" | "column",
  newSessionId: string
): LayoutNode {
  const path = findLeafPath(tree, targetSessionId);
  if (!path) throw new Error(`session ${targetSessionId} not found in layout`);
  const result = replaceAtPath(tree, path, (leaf) => ({
    type: "split",
    direction,
    children: [leaf, { type: "leaf", tabs: [newSessionId], activeTabIndex: 0 }],
    sizes: [0.5, 0.5],
  }));
  return result as LayoutNode;
}

export function addTab(tree: LayoutNode, targetSessionId: string, newSessionId: string): LayoutNode {
  const path = findLeafPath(tree, targetSessionId);
  if (!path) throw new Error(`session ${targetSessionId} not found in layout`);
  const result = replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    const tabs = [...leaf.tabs, newSessionId];
    return normalizeLeaf({ type: "leaf", tabs, activeTabIndex: tabs.length - 1, pinned: leaf.pinned });
  });
  return result as LayoutNode;
}

export function closeTab(tree: LayoutNode, sessionId: string): LayoutNode | null {
  const path = findLeafPath(tree, sessionId);
  if (!path) throw new Error(`session ${sessionId} not found in layout`);
  return replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    const removedIndex = leaf.tabs.indexOf(sessionId);
    const tabs = leaf.tabs.filter((id) => id !== sessionId);
    if (tabs.length === 0) return null;
    const activeTabIndex =
      leaf.activeTabIndex > removedIndex ? leaf.activeTabIndex - 1 : Math.min(leaf.activeTabIndex, tabs.length - 1);
    return normalizeLeaf({
      type: "leaf",
      tabs,
      activeTabIndex,
      pinned: (leaf.pinned ?? []).filter((id) => id !== sessionId),
    });
  });
}

// Locates the leaf containing anchorSessionId and removes it from the
// tree entirely (reusing replaceAtPath's existing collapse-on-null
// mechanics -- the same removal path closeTab already relies on),
// returning both the resulting tree (possibly null, if that leaf was the
// whole tree) and the detached leaf intact, ready to be grafted
// elsewhere. Returns null if anchorSessionId isn't in the tree at all.
export function detachLeaf(
  tree: LayoutNode,
  anchorSessionId: string
): { tree: LayoutNode | null; detached: Extract<LayoutNode, { type: "leaf" }> } | null {
  const path = findLeafPath(tree, anchorSessionId);
  if (!path) return null;
  const detached = getNodeAtPath(tree, path);
  if (detached.type !== "leaf") return null;
  const newTree = replaceAtPath(tree, path, () => null);
  return { tree: newTree, detached };
}

// Removes one tab from its leaf -- collapsing the leaf if it was the last
// tab (identical to closeTab's own removal semantics) -- and returns a
// new standalone single-tab leaf holding the removed session as the
// "detached" piece. Returns null if sessionId isn't in the tree.
export function detachTab(
  tree: LayoutNode,
  sessionId: string
): { tree: LayoutNode | null; detached: Extract<LayoutNode, { type: "leaf" }> } | null {
  if (!findLeafPath(tree, sessionId)) return null;
  const wasPinned = isPinned(tree, sessionId);
  const newTree = closeTab(tree, sessionId);
  const detached: Leaf = wasPinned
    ? { type: "leaf", tabs: [sessionId], activeTabIndex: 0, pinned: [sessionId] }
    : { type: "leaf", tabs: [sessionId], activeTabIndex: 0 };
  return { tree: newTree, detached };
}

export type GraftMode = "left" | "right" | "top" | "bottom";

// Grafts `incoming` onto `targetTree`. If targetTree is null (an empty
// page), incoming simply becomes the whole tree. Otherwise wraps the
// existing tree and incoming into a new top-level split -- left/right
// produce a row split, top/bottom a column split; left/top place
// incoming first in the children array (so it renders on that side),
// right/bottom place it last.
export function graftLeaf(
  targetTree: LayoutNode | null,
  incoming: Extract<LayoutNode, { type: "leaf" }>,
  mode: GraftMode
): LayoutNode {
  if (!targetTree) return incoming;
  const direction: Direction = mode === "left" || mode === "right" ? "row" : "column";
  const children: LayoutNode[] =
    mode === "left" || mode === "top" ? [incoming, targetTree] : [targetTree, incoming];
  return { type: "split", direction, children, sizes: [0.5, 0.5] };
}

// Like graftLeaf, but wraps a split at the SPECIFIC leaf identified by
// anchorSessionId within the tree, rather than always wrapping the whole
// tree at its root -- so grafting onto one pane of a multi-pane page (a
// 2x2 grid, say) only affects that one pane, not the entire page layout.
// Falls back to graftLeaf's whole-tree behavior if anchorSessionId isn't
// found (e.g. it was the same session just detached as part of this same
// move, so it no longer exists anywhere in the tree).
export function graftLeafAt(
  tree: LayoutNode,
  anchorSessionId: string,
  incoming: Extract<LayoutNode, { type: "leaf" }>,
  mode: GraftMode
): LayoutNode {
  const path = findLeafPath(tree, anchorSessionId);
  if (!path) return graftLeaf(tree, incoming, mode);
  const direction: Direction = mode === "left" || mode === "right" ? "row" : "column";
  return (
    replaceAtPath(tree, path, (node) => {
      const children: LayoutNode[] = mode === "left" || mode === "top" ? [incoming, node] : [node, incoming];
      return { type: "split", direction, children, sizes: [0.5, 0.5] };
    }) ?? tree
  );
}

// Inserts every tab from `incoming` into the leaf identified by
// targetFocusedSessionId (falling back to the tree's first leaf if that
// id isn't present, or is null), mirroring addTab's "new tab becomes
// active" behavior for the first of incoming's tabs.
//
// `insertIndex` is a position in that leaf's tabs array; omitted means
// the end, which is where a drop that named no position -- the sidebar's
// (the target page isn't even rendered), or one on the pane's body --
// has always put it. A drop ON the tab bar does name one, and has to be
// obeyed: the bar draws an insertion caret under the pointer while the
// drag is live, so appending regardless would make that caret a lie.
//
// Pinning is not clamped here on purpose: normalizeLeaf already keeps
// the pinned block a prefix, so an unpinned tab inserted among pinned
// ones slides to just after them and a pinned one to the end of the
// block, which is the same rule clampReorderIndex spells out for a
// same-pane reorder.
export function mergeIntoActivePane(
  targetTree: LayoutNode,
  targetFocusedSessionId: string | null,
  incoming: Extract<LayoutNode, { type: "leaf" }>,
  insertIndex?: number
): LayoutNode {
  const anchorId =
    targetFocusedSessionId && findLeafPath(targetTree, targetFocusedSessionId)
      ? targetFocusedSessionId
      : allSessionIds(targetTree)[0];
  if (anchorId === undefined) return targetTree;
  const path = findLeafPath(targetTree, anchorId);
  if (!path) return targetTree;
  return (
    replaceAtPath(targetTree, path, (node) => {
      if (node.type !== "leaf") return node;
      const at =
        insertIndex === undefined ? node.tabs.length : Math.max(0, Math.min(insertIndex, node.tabs.length));
      return normalizeLeaf({
        type: "leaf",
        tabs: [...node.tabs.slice(0, at), ...incoming.tabs, ...node.tabs.slice(at)],
        activeTabIndex: at,
        pinned: [...(node.pinned ?? []), ...(incoming.pinned ?? [])],
      });
    }) ?? targetTree
  );
}

// Reorders a tab within its own leaf's tabs array, keeping activeTabIndex
// pointing at whichever session was active before the move (which may or
// may not be the session that just moved).
export function moveTabWithinLeaf(tree: LayoutNode, sessionId: string, targetIndex: number): LayoutNode {
  const path = findLeafPath(tree, sessionId);
  if (!path) return tree;
  return (
    replaceAtPath(tree, path, (node) => {
      if (node.type !== "leaf") return node;
      const activeId = node.tabs[node.activeTabIndex];
      const currentIndex = node.tabs.indexOf(sessionId);
      if (currentIndex === -1) return node;
      const tabs = [...node.tabs];
      tabs.splice(currentIndex, 1);
      const clampedTarget = clampReorderIndex(node, sessionId, targetIndex);
      tabs.splice(clampedTarget, 0, sessionId);
      return normalizeLeaf({ type: "leaf", tabs, activeTabIndex: tabs.indexOf(activeId), pinned: node.pinned });
    }) ?? tree
  );
}

export function switchTab(tree: LayoutNode, sessionId: string): LayoutNode {
  const path = findLeafPath(tree, sessionId);
  if (!path) throw new Error(`session ${sessionId} not found in layout`);
  const result = replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    return { ...leaf, activeTabIndex: leaf.tabs.indexOf(sessionId) };
  });
  return result as LayoutNode;
}

export function resizeSplit(tree: LayoutNode, splitPath: number[], sizes: number[]): LayoutNode {
  const result = replaceAtPath(tree, splitPath, (node) => {
    if (node.type !== "split") throw new Error("expected a split at the given path");
    if (sizes.length !== node.children.length) throw new Error("sizes length mismatch");
    return { ...node, sizes };
  });
  return result as LayoutNode;
}

export function allSessionIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [...node.tabs];
  return node.children.flatMap(allSessionIds);
}

// Every pane in the tree, in the same left-to-right, top-to-bottom order
// allSessionIds walks. A pane is the unit that DISAPPEARS when its last
// tab goes (closeTab prunes an empty leaf), so anything that closes tabs
// in bulk has to be able to ask which panes a batch would empty.
export function allLeaves(node: LayoutNode): Leaf[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(allLeaves);
}

// A file, board or card tab is not a terminal session: closing one ends
// no process, and no agent runs behind one. The three id maps are the
// only thing that distinguishes them -- a tab absent from all three IS a
// terminal session. Lives here, with allSessionIds, because both the
// close-page prompt ("N terminal sessions will end") and the sidebar's
// per-page recap have to mean the same thing by "session".
//
// Every map is a required argument rather than an optional or a rest
// parameter on purpose: a fourth tab kind added later must break every
// call site, because the failure of forgetting one is silent (a pane
// counted as an agent, a close prompt threatening to end a process that
// does not exist).
export function sessionTabsOnly(
  ids: string[],
  fileTabsById: Record<string, unknown>,
  boardTabsById: Record<string, unknown>,
  cardTabsById: Record<string, unknown>
): string[] {
  return ids.filter((id) => !fileTabsById[id] && !boardTabsById[id] && !cardTabsById[id]);
}

// Which pane on a page draws the row of actions at the top right --
// exactly one of them, whatever the page is split into.
//
// Every pane used to draw its own. On a page split four ways that is
// four copies of Split Right / Split Down / Close Pane / New page across
// the top of the window, and the copies are not interchangeable: each
// one acts on the pane it sits on, so the row a human reads as "the
// window's toolbar" is really four toolbars that differ only in where
// they are. The focused pane is the one the keyboard already addresses,
// and the underline on its active tab already says which one it is, so
// it is the pane whose actions are worth showing.
//
// The two fallbacks exist so the row can never go missing entirely --
// New page lives in it, and a page with no toolbar at all is a dead end:
//
// - no tree to consult: show them (the caller has nothing better).
// - a focus that names no pane on this page: the FIRST pane speaks for
//   the page, matching the order resolveFocusForPage would pick anyway.
export function paneOwnsActions(
  tree: LayoutNode | null,
  leaf: Leaf,
  focusedSessionId: string | null
): boolean {
  if (focusedSessionId !== null && leaf.tabs.includes(focusedSessionId)) return true;
  if (!tree) return true;
  const ids = allSessionIds(tree);
  if (focusedSessionId !== null && ids.includes(focusedSessionId)) return false;
  return ids.length === 0 || leaf.tabs.includes(ids[0]);
}

// Which pane on a page draws the WINDOW's chrome at the top left -- the
// sidebar's collapse toggle, its search, and "Open workspace…".
//
// Deliberately not paneOwnsActions' rule. That one follows the keyboard,
// which is right for actions that act on a pane: the toolbar belongs
// with the pane it would split or close. These act on the window, and a
// window control that moved to whichever pane was last clicked would be
// a control that is never in the corner. So it is the first pane in the
// tree -- allSessionIds walks left-to-right, top-to-bottom, so the first
// session on the page is always in the top-left pane, whatever the page
// is split into.
//
// Same fallbacks as paneOwnsActions, for the same reason: the collapse
// toggle is the only way back from a collapsed rail, so it can never go
// missing entirely.
export function paneLeadsWindow(tree: LayoutNode | null, leaf: Leaf): boolean {
  if (!tree) return true;
  const ids = allSessionIds(tree);
  return ids.length === 0 || leaf.tabs.includes(ids[0]);
}

export function activeSessionId(leaf: Extract<LayoutNode, { type: "leaf" }>): string {
  return leaf.tabs[leaf.activeTabIndex];
}

export function presetSingle(sessionId: string): LayoutNode {
  return { type: "leaf", tabs: [sessionId], activeTabIndex: 0 };
}

export function presetSideBySide(leftId: string, rightId: string): LayoutNode {
  return {
    type: "split",
    direction: "row",
    children: [presetSingle(leftId), presetSingle(rightId)],
    sizes: [0.5, 0.5],
  };
}

export function presetGrid2x2(
  topLeft: string,
  topRight: string,
  bottomLeft: string,
  bottomRight: string
): LayoutNode {
  return {
    type: "split",
    direction: "column",
    children: [
      {
        type: "split",
        direction: "row",
        children: [presetSingle(topLeft), presetSingle(topRight)],
        sizes: [0.5, 0.5],
      },
      {
        type: "split",
        direction: "row",
        children: [presetSingle(bottomLeft), presetSingle(bottomRight)],
        sizes: [0.5, 0.5],
      },
    ],
    sizes: [0.5, 0.5],
  };
}

/// N panes on one page, for a layout gavin builds rather than one the
/// human picked from the "New page" menu -- a best-of-N run, where the
/// pane count is however many agents were entered.
///
/// One row up to three, rows of two beyond. Terminals are read down, so
/// width is the scarce dimension: a fourth agent in a fourth column
/// leaves each one about 350px on a laptop, which is narrower than the
/// agents' own output. Two per row keeps every candidate readable and
/// costs only vertical space, which scrolls anyway.
///
/// Agrees with the three hand-written presets at 1, 2 and 4 -- there is
/// no second answer to "two panes side by side" in this app, and the
/// tests hold that. An empty list is `presetSingle("")`'s shape rather
/// than a null: every caller here has already created its sessions, so
/// zero is unreachable, and a tree-shaped return keeps it that way.
export function presetTiled(sessionIds: string[]): LayoutNode {
  if (sessionIds.length <= 1) return presetSingle(sessionIds[0] ?? "");
  const perRow = sessionIds.length <= 3 ? sessionIds.length : 2;
  const rows: LayoutNode[] = [];
  for (let i = 0; i < sessionIds.length; i += perRow) {
    const slice = sessionIds.slice(i, i + perRow);
    rows.push(
      slice.length === 1
        ? presetSingle(slice[0])
        : {
            type: "split",
            direction: "row",
            children: slice.map(presetSingle),
            sizes: slice.map(() => 1 / slice.length),
          }
    );
  }
  if (rows.length === 1) return rows[0];
  return { type: "split", direction: "column", children: rows, sizes: rows.map(() => 1 / rows.length) };
}
