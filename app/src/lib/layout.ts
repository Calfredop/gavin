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

// Appends every tab from `incoming` onto the leaf identified by
// targetFocusedSessionId (falling back to the tree's first leaf if that
// id isn't present, or is null), mirroring addTab's "new tab becomes
// active" behavior for the last of incoming's tabs.
export function mergeIntoActivePane(
  targetTree: LayoutNode,
  targetFocusedSessionId: string | null,
  incoming: Extract<LayoutNode, { type: "leaf" }>
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
      return normalizeLeaf({
        type: "leaf",
        tabs: [...node.tabs, ...incoming.tabs],
        activeTabIndex: node.tabs.length,
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

// Neither a file tab nor a board tab is a terminal session: closing one
// ends no process, and no agent runs behind one. The two id maps are the
// only thing that distinguishes them -- a tab absent from both IS a
// terminal session. Lives here, with allSessionIds, because both the
// close-page prompt ("N terminal sessions will end") and the sidebar's
// per-page recap have to mean the same thing by "session".
export function sessionTabsOnly(
  ids: string[],
  fileTabsById: Record<string, unknown>,
  boardTabsById: Record<string, unknown>
): string[] {
  return ids.filter((id) => !fileTabsById[id] && !boardTabsById[id]);
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
