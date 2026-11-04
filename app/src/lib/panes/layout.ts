export type Direction = "row" | "column";

/// A tab's Attached views (ADR 0013, CONTEXT.md "Attached view"): what a
/// terminal tab opened of its own work -- its plan, its run's changes, its
/// follow-ups, its browser, a file or a board -- drawn as ONE side pane
/// inside the tab's own pane, and only while that tab is the active one.
/// The tab and these views are its Tab group.
///
/// `tabs` is the side pane's own strip, in order; `activeTabIndex` the
/// view in front there; `size` the side pane's share of the pane's width,
/// which is remembered per group and starts at half.
export interface AttachedGroup {
  tabs: string[];
  activeTabIndex: number;
  size: number;
}

export type LayoutNode =
  | {
      type: "leaf";
      tabs: string[];
      activeTabIndex: number;
      pinned?: string[];
      /// Attached views keyed by the tab that owns them, which is always
      /// one of `tabs`. Absent when no tab has any, so state written
      /// before groups existed stays byte-identical, and a page saved
      /// then -- whose views are ordinary panes -- is left exactly as it
      /// was: nothing in it says which tab a pane belonged to.
      attached?: Record<string, AttachedGroup>;
    }
  | { type: "split"; direction: Direction; children: LayoutNode[]; sizes: number[] };

export type Leaf = Extract<LayoutNode, { type: "leaf" }>;

/// Where a side pane's divider starts, and the range a drag may take it
/// to: past either end one half or the other is too narrow to read.
export const ATTACHED_DEFAULT_SIZE = 0.5;
export const ATTACHED_MIN_SIZE = 0.15;
export const ATTACHED_MAX_SIZE = 0.85;

function clampAttachedSize(size: number): number {
  if (!Number.isFinite(size)) return ATTACHED_DEFAULT_SIZE;
  return Math.min(ATTACHED_MAX_SIZE, Math.max(ATTACHED_MIN_SIZE, size));
}

// The groups a leaf may keep: owned by one of its tabs, never empty, a
// view in at most one group and never a tab of the leaf itself, the
// front view an index that exists. Walked in `tabs` order so a group's
// position follows its owner's.
function normalizeAttached(
  attached: Record<string, AttachedGroup> | undefined,
  tabs: string[]
): Record<string, AttachedGroup> | undefined {
  if (!attached) return undefined;
  const seen = new Set(tabs);
  const out: Record<string, AttachedGroup> = {};
  for (const owner of tabs) {
    const group = attached[owner];
    if (!group) continue;
    const views = group.tabs.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (views.length === 0) continue;
    const frontId = group.tabs[group.activeTabIndex];
    const front = views.indexOf(frontId);
    out[owner] = {
      tabs: views,
      activeTabIndex: front >= 0 ? front : Math.min(Math.max(0, group.activeTabIndex), views.length - 1),
      size: clampAttachedSize(group.size),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Pinned tabs live as a PREFIX of `tabs` (browser-style). Every mutation
// funnels through this so the invariant holds: pinned ids not in `tabs`
// are dropped, pinned tabs are moved first keeping their relative order,
// the active tab stays active, and an empty `pinned` is omitted so state
// written before pinning existed stays byte-identical.
//
// The same for Attached views: a group whose owner has left `tabs` goes
// with it (closing a tab closes its group), and no groups at all is no
// `attached` key.
export function normalizeLeaf(leaf: Leaf): Leaf {
  const pinned = (leaf.pinned ?? []).filter((id) => leaf.tabs.includes(id));
  const pinnedSet = new Set(pinned);
  const activeId = leaf.tabs[leaf.activeTabIndex];
  const tabs = [...leaf.tabs.filter((t) => pinnedSet.has(t)), ...leaf.tabs.filter((t) => !pinnedSet.has(t))];
  const activeTabIndex = Math.max(0, tabs.indexOf(activeId));
  const orderedPinned = tabs.filter((t) => pinnedSet.has(t));
  const attached = normalizeAttached(leaf.attached, tabs);
  const normalized: Leaf = { type: "leaf", tabs, activeTabIndex };
  if (orderedPinned.length > 0) normalized.pinned = orderedPinned;
  if (attached) normalized.attached = attached;
  return normalized;
}

/// The tab that owns `id` as an Attached view in this leaf, or null when
/// `id` is one of its ordinary tabs or not here at all.
export function attachedOwner(leaf: Leaf, id: string): string | null {
  for (const [owner, group] of Object.entries(leaf.attached ?? {})) {
    if (group.tabs.includes(id)) return owner;
  }
  return null;
}

/// `ownerId`'s Attached views in this leaf, or null when it has none.
export function attachedGroup(leaf: Leaf, ownerId: string): AttachedGroup | null {
  return leaf.attached?.[ownerId] ?? null;
}

/// Whether `id` is in this pane: one of its tabs, or a view attached to
/// one of them. What "the focused pane" means once focus can sit inside a
/// group -- the group's header is its owner's, wherever focus sits.
export function leafHolds(leaf: Leaf, id: string): boolean {
  return leaf.tabs.includes(id) || attachedOwner(leaf, id) !== null;
}

/// The owner of an Attached view anywhere in the tree, or null.
export function ownerOfAttached(tree: LayoutNode, id: string): string | null {
  const path = findLeafPath(tree, id);
  if (!path) return null;
  const leaf = getNodeAtPath(tree, path);
  return leaf.type === "leaf" ? attachedOwner(leaf, id) : null;
}

/// The Attached views owned by `ownerId`, wherever it is in the tree.
export function attachedViewsOf(tree: LayoutNode, ownerId: string): string[] {
  const path = findLeafPath(tree, ownerId);
  if (!path) return [];
  const leaf = getNodeAtPath(tree, path);
  return leaf.type === "leaf" ? [...(leaf.attached?.[ownerId]?.tabs ?? [])] : [];
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

// An Attached view resolves to its owner's pane: it is drawn inside it,
// focus sitting on it is focus in that pane, and closing or moving the
// pane takes it along.
export function findLeafPath(node: LayoutNode, sessionId: string, path: number[] = []): number[] | null {
  if (node.type === "leaf") {
    return leafHolds(node, sessionId) ? path : null;
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
  return leaf.type === "leaf" && leaf.tabs.length === 1 && leaf.tabs[0] === sessionId;
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
    return normalizeLeaf({
      type: "leaf",
      tabs,
      activeTabIndex: tabs.length - 1,
      pinned: leaf.pinned,
      attached: leaf.attached,
    });
  });
  return result as LayoutNode;
}

// Closing an Attached view takes it out of its group (and the group out
// of the leaf once it is empty, which is the side pane disappearing);
// the pane itself never goes, its owner is still in it. Closing a tab
// takes its group with it -- normalizeLeaf drops a group whose owner has
// left `tabs`.
export function closeTab(tree: LayoutNode, sessionId: string): LayoutNode | null {
  const path = findLeafPath(tree, sessionId);
  if (!path) throw new Error(`session ${sessionId} not found in layout`);
  return replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    const owner = attachedOwner(leaf, sessionId);
    if (owner !== null) return withoutAttached(leaf, owner, sessionId);
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
      attached: leaf.attached,
    });
  });
}

// One view out of `owner`'s group. The view beside it comes to the front
// when the front one goes -- the one to its right, or the new last.
function withoutAttached(leaf: Leaf, owner: string, viewId: string): Leaf {
  const group = leaf.attached?.[owner];
  if (!group) return leaf;
  const removedIndex = group.tabs.indexOf(viewId);
  const tabs = group.tabs.filter((id) => id !== viewId);
  const activeTabIndex =
    group.activeTabIndex > removedIndex ? group.activeTabIndex - 1 : Math.min(group.activeTabIndex, tabs.length - 1);
  const attached = { ...leaf.attached };
  if (tabs.length > 0) attached[owner] = { ...group, tabs, activeTabIndex: Math.max(0, activeTabIndex) };
  else delete attached[owner];
  return normalizeLeaf({ ...leaf, attached });
}

/// Adds `viewId` to `ownerId`'s group -- opening the side pane at its
/// default width if the tab had none -- and puts it in front there, with
/// the owner made the pane's active tab so the view is on screen. A view
/// already in the group is only brought forward: the opens de-duplicate
/// before they get here, and this keeps a second call from listing the
/// same id twice. Unchanged when `ownerId` is not an ordinary tab in the
/// tree, since only a tab can own a group.
///
/// `activate: false` is an open nobody asked for (the browser's own
/// automatic one): the view joins the group, but neither the pane's
/// active tab nor the strip's front view moves -- a pane showing (b) must
/// not switch to (a) because (a)'s browser started.
export function attachView(
  tree: LayoutNode,
  ownerId: string,
  viewId: string,
  opts: { activate?: boolean } = {}
): LayoutNode {
  const activate = opts.activate ?? true;
  const path = findLeafPath(tree, ownerId);
  if (!path) return tree;
  return (
    replaceAtPath(tree, path, (node) => {
      if (node.type !== "leaf" || !node.tabs.includes(ownerId)) return node;
      const group = node.attached?.[ownerId];
      const tabs = group ? (group.tabs.includes(viewId) ? group.tabs : [...group.tabs, viewId]) : [viewId];
      return normalizeLeaf({
        ...node,
        activeTabIndex: activate ? node.tabs.indexOf(ownerId) : node.activeTabIndex,
        attached: {
          ...node.attached,
          [ownerId]: {
            tabs,
            activeTabIndex: activate || !group ? tabs.indexOf(viewId) : group.activeTabIndex,
            size: group?.size ?? ATTACHED_DEFAULT_SIZE,
          },
        },
      });
    }) ?? tree
  );
}

/// Takes `ownerId`'s whole group away -- the X at the end of the side
/// strip. The views' own bookkeeping (their tab maps) is the caller's.
export function closeAttachedGroup(tree: LayoutNode, ownerId: string): LayoutNode {
  const path = findLeafPath(tree, ownerId);
  if (!path) return tree;
  return (
    replaceAtPath(tree, path, (node) => {
      if (node.type !== "leaf" || !node.attached?.[ownerId]) return node;
      const attached = { ...node.attached };
      delete attached[ownerId];
      return normalizeLeaf({ ...node, attached });
    }) ?? tree
  );
}

/// Where `ownerId`'s side pane divider sits, as the side pane's share of
/// the pane's width. Clamped, like a split's divider, so neither half can
/// be dragged out of existence.
export function resizeAttached(tree: LayoutNode, ownerId: string, size: number): LayoutNode {
  const path = findLeafPath(tree, ownerId);
  if (!path) return tree;
  return (
    replaceAtPath(tree, path, (node) => {
      const group = node.type === "leaf" ? node.attached?.[ownerId] : undefined;
      if (node.type !== "leaf" || !group) return node;
      return { ...node, attached: { ...node.attached, [ownerId]: { ...group, size: clampAttachedSize(size) } } };
    }) ?? tree
  );
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
//
// A tab that owns Attached views takes them with it: the group is the
// tab's, wherever the tab goes. An Attached view dragged out of its side
// strip is the other half of that -- out of its group, it becomes an
// ordinary tab of its own, which is the only way a view is detached.
export function detachTab(
  tree: LayoutNode,
  sessionId: string
): { tree: LayoutNode | null; detached: Extract<LayoutNode, { type: "leaf" }> } | null {
  const path = findLeafPath(tree, sessionId);
  if (!path) return null;
  const source = getNodeAtPath(tree, path);
  const group = source.type === "leaf" ? source.attached?.[sessionId] : undefined;
  const wasPinned = isPinned(tree, sessionId);
  const newTree = closeTab(tree, sessionId);
  const detached: Leaf = { type: "leaf", tabs: [sessionId], activeTabIndex: 0 };
  if (wasPinned) detached.pinned = [sessionId];
  if (group) detached.attached = { [sessionId]: group };
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
        attached: node.attached || incoming.attached ? { ...node.attached, ...incoming.attached } : undefined,
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
      return normalizeLeaf({
        type: "leaf",
        tabs,
        activeTabIndex: tabs.indexOf(activeId),
        pinned: node.pinned,
        attached: node.attached,
      });
    }) ?? tree
  );
}

// Switching to an Attached view switches to its owner and brings the
// view to the front of the side strip -- choosing it means "show me it",
// and it is only ever on screen beside its owner.
export function switchTab(tree: LayoutNode, sessionId: string): LayoutNode {
  const path = findLeafPath(tree, sessionId);
  if (!path) throw new Error(`session ${sessionId} not found in layout`);
  const result = replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    const owner = attachedOwner(leaf, sessionId);
    if (owner === null) return { ...leaf, activeTabIndex: leaf.tabs.indexOf(sessionId) };
    const group = leaf.attached![owner];
    return {
      ...leaf,
      activeTabIndex: leaf.tabs.indexOf(owner),
      attached: { ...leaf.attached, [owner]: { ...group, activeTabIndex: group.tabs.indexOf(sessionId) } },
    };
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

// The page tree's own tabs -- never an Attached view. Everything that
// looks for terminals (the sidebar, the attention inbox, the close
// prompts, idle tabs) reads this, and a view is never a terminal
// (ADR 0013), so it keeps finding exactly what it found before groups.
export function allSessionIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [...node.tabs];
  return node.children.flatMap(allSessionIds);
}

/// Every id the tree holds, Attached views included, each group straight
/// after its owner. For what has to see every view tab -- closing a page
/// or a workspace ends them too, and their tab maps are pruned by id.
export function allTabIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return node.tabs.flatMap((id) => [id, ...(node.attached?.[id]?.tabs ?? [])]);
  return node.children.flatMap(allTabIds);
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
  // leafHolds, not `tabs`: focus inside a Tab group is focus in its
  // owner's pane, whose header the group reads.
  if (focusedSessionId !== null && leafHolds(leaf, focusedSessionId)) return true;
  if (!tree) return true;
  const ids = allSessionIds(tree);
  if (focusedSessionId !== null && findLeafPath(tree, focusedSessionId) !== null) return false;
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
