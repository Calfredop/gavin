export type LayoutNode =
  | { type: "leaf"; tabs: string[]; activeTabIndex: number }
  | { type: "split"; direction: "row" | "column"; children: LayoutNode[]; sizes: number[] };

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
    return { type: "leaf", tabs, activeTabIndex: tabs.length - 1 };
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
    return { type: "leaf", tabs, activeTabIndex };
  });
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
