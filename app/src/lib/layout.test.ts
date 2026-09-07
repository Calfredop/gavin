import { describe, it, expect } from "vitest";
import {
  findLeafPath,
  getNodeAtPath,
  isLastTabInPane,
  splitLeaf,
  addTab,
  closeTab,
  detachLeaf,
  detachTab,
  graftLeaf,
  graftLeafAt,
  mergeIntoActivePane,
  moveTabWithinLeaf,
  switchTab,
  resizeSplit,
  allSessionIds,
  activeSessionId,
  presetSingle,
  presetSideBySide,
  presetGrid2x2,
  normalizeLeaf,
  isPinned,
  pinTab,
  unpinTab,
  clampReorderIndex,
  bulkCloseTargets,
  presetTiled,
  paneOwnsActions,
  paneLeadsWindow,
} from "./layout";
import type { LayoutNode, Leaf } from "./layout";

describe("findLeafPath", () => {
  it("finds a leaf at the root", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(findLeafPath(tree, "a")).toEqual([]);
  });

  it("finds a leaf nested inside splits", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c", "d"], activeTabIndex: 1 },
          ],
        },
      ],
    };
    expect(findLeafPath(tree, "d")).toEqual([1, 1]);
  });

  it("returns null when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(findLeafPath(tree, "z")).toBeNull();
  });
});

describe("getNodeAtPath", () => {
  it("returns the root when path is empty", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(getNodeAtPath(tree, [])).toEqual(tree);
  });

  it("walks nested splits", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    expect(getNodeAtPath(tree, [1])).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });
});

describe("isLastTabInPane", () => {
  it("returns true when the session is the only tab in its leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(isLastTabInPane(tree, "a")).toBe(true);
  });

  it("returns false when the session shares its leaf with other tabs", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    expect(isLastTabInPane(tree, "a")).toBe(false);
  });

  it("returns false for a session id not present in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(isLastTabInPane(tree, "missing")).toBe(false);
  });

  it("checks the correct leaf when nested inside a split", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "c"], activeTabIndex: 0 },
      ],
    };
    expect(isLastTabInPane(tree, "a")).toBe(true);
    expect(isLastTabInPane(tree, "b")).toBe(false);
  });
});

describe("splitLeaf", () => {
  it("wraps a root leaf in a new row split", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = splitLeaf(tree, "a", "row", "b");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
  });

  it("splits a leaf nested inside an existing split without disturbing siblings", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = splitLeaf(tree, "b", "column", "c");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
          ],
        },
      ],
    });
  });

  it("throws when the target session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(() => splitLeaf(tree, "missing", "row", "b")).toThrow();
  });
});

describe("addTab", () => {
  it("appends a tab and makes it active", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = addTab(tree, "a", "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 });
  });

  it("adds to the correct leaf when nested inside a split", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = addTab(tree, "b", "c");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "c"], activeTabIndex: 1 },
      ],
    });
  });
});

describe("closeTab", () => {
  it("removes a tab and shifts activeTabIndex left when needed", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 2 };
    const result = closeTab(tree, "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a", "c"], activeTabIndex: 1 });
  });

  it("keeps activeTabIndex in bounds when closing the active tab", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    const result = closeTab(tree, "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("collapses a two-child split down to the remaining leaf", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = closeTab(tree, "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns null when closing the tree's very last tab", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(closeTab(tree, "a")).toBeNull();
  });

  it("collapsing a nested split doesn't disturb its sibling subtree", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["untouched"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
          ],
        },
      ],
    };
    const result = closeTab(tree, "c");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["untouched"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
  });
});

describe("switchTab", () => {
  it("updates activeTabIndex to point at the given session", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 };
    const result = switchTab(tree, "c");
    expect(result).toEqual({ type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 2 });
  });
});

describe("resizeSplit", () => {
  it("updates only the targeted split's sizes", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = resizeSplit(tree, [], [0.3, 0.7]);
    expect(result).toEqual({ ...tree, sizes: [0.3, 0.7] });
  });

  it("updates a nested split without disturbing its parent's sizes", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
          ],
        },
      ],
    };
    const result = resizeSplit(tree, [1], [0.2, 0.8]);
    expect(result).toEqual({
      ...tree,
      children: [tree.children[0], { ...(tree.children[1] as LayoutNode & { type: "split" }), sizes: [0.2, 0.8] }],
    });
  });
});

describe("allSessionIds", () => {
  it("collects every tab across nested splits", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
      ],
    };
    expect(allSessionIds(tree)).toEqual(["a", "b", "c"]);
  });
});

describe("activeSessionId", () => {
  it("returns the tab at activeTabIndex", () => {
    const leaf: LayoutNode & { type: "leaf" } = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    expect(activeSessionId(leaf)).toBe("b");
  });
});

describe("presets", () => {
  it("presetSingle builds a one-tab leaf", () => {
    expect(presetSingle("a")).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("presetSideBySide builds a row split of two single-tab leaves", () => {
    expect(presetSideBySide("a", "b")).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
  });

  it("presetGrid2x2 builds a column split of two row splits", () => {
    const result = presetGrid2x2("a", "b", "c", "d");
    expect(result).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
          ],
        },
        {
          type: "split",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["d"], activeTabIndex: 0 },
          ],
        },
      ],
    });
  });
});

describe("detachLeaf", () => {
  it("removes a leaf from a split, returning the shrunken tree and the detached leaf", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "c"], activeTabIndex: 0 },
      ],
    };
    const result = detachLeaf(tree, "a");
    expect(result).not.toBeNull();
    expect(result?.tree).toEqual({ type: "leaf", tabs: ["b", "c"], activeTabIndex: 0 });
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns a null tree when detaching the whole tree's only leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = detachLeaf(tree, "a");
    expect(result?.tree).toBeNull();
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns null when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(detachLeaf(tree, "z")).toBeNull();
  });
});

describe("detachTab", () => {
  it("removes one tab from a multi-tab leaf, returning it as a standalone detached leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    const result = detachTab(tree, "b");
    expect(result?.tree).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });

  it("collapses to null when detaching the last tab in a leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = detachTab(tree, "a");
    expect(result?.tree).toBeNull();
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns null when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(detachTab(tree, "z")).toBeNull();
  });
});

describe("graftLeaf", () => {
  const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };

  it("becomes the whole tree when the target is null (an empty page)", () => {
    expect(graftLeaf(null, incoming, "right")).toEqual(incoming);
  });

  it("wraps into a row split with incoming last, for mode right", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(graftLeaf(target, incoming, "right")).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [target, incoming],
    });
  });

  it("wraps into a row split with incoming first, for mode left", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(graftLeaf(target, incoming, "left")).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [incoming, target],
    });
  });

  it("wraps into a column split for mode top/bottom", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(graftLeaf(target, incoming, "bottom")).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [target, incoming],
    });
    expect(graftLeaf(target, incoming, "top")).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [incoming, target],
    });
  });
});

describe("graftLeafAt", () => {
  it("grafts at the specific pane identified by anchorSessionId, not the whole tree", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    const result = graftLeafAt(tree, "b", incoming, "right");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [{ type: "leaf", tabs: ["b"], activeTabIndex: 0 }, incoming],
        },
      ],
    });
  });

  it("respects mode ordering the same way graftLeaf does", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    expect(graftLeafAt(tree, "a", incoming, "top")).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [incoming, tree],
    });
  });

  it("falls back to graftLeaf's whole-tree behavior when the anchor isn't found", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    expect(graftLeafAt(tree, "missing", incoming, "right")).toEqual(graftLeaf(tree, incoming, "right"));
  });
});

describe("mergeIntoActivePane", () => {
  it("appends incoming's tabs onto the leaf matching targetFocusedSessionId", () => {
    const target: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    const result = mergeIntoActivePane(target, "b", incoming);
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "new"], activeTabIndex: 1 },
      ],
    });
  });

  it("falls back to the tree's first leaf when targetFocusedSessionId is null", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    expect(mergeIntoActivePane(target, null, incoming)).toEqual({
      type: "leaf",
      tabs: ["a", "new"],
      activeTabIndex: 1,
    });
  });

  it("falls back to the tree's first leaf when targetFocusedSessionId is stale", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    expect(mergeIntoActivePane(target, "gone", incoming)).toEqual({
      type: "leaf",
      tabs: ["a", "new"],
      activeTabIndex: 1,
    });
  });

  it("merges multiple incoming tabs at once", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["x", "y"], activeTabIndex: 0 };
    expect(mergeIntoActivePane(target, "a", incoming)).toEqual({
      type: "leaf",
      tabs: ["a", "x", "y"],
      activeTabIndex: 1,
    });
  });
});

describe("moveTabWithinLeaf", () => {
  it("moves a tab to a later index, keeping the same session active", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 1 };
    expect(moveTabWithinLeaf(tree, "a", 2)).toEqual({ type: "leaf", tabs: ["b", "c", "a"], activeTabIndex: 0 });
  });

  it("moves a tab to an earlier index", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "c", 0)).toEqual({ type: "leaf", tabs: ["c", "a", "b"], activeTabIndex: 1 });
  });

  it("moving the active tab itself keeps it active at its new position", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "a", 2)).toEqual({ type: "leaf", tabs: ["b", "c", "a"], activeTabIndex: 2 });
  });

  it("clamps an out-of-range target index", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "a", 99)).toEqual({ type: "leaf", tabs: ["b", "a"], activeTabIndex: 1 });
  });

  it("is a no-op when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "z", 0)).toEqual(tree);
  });
});

describe("pinning", () => {
  const leaf = (tabs: string[], activeTabIndex = 0, pinned?: string[]): LayoutNode =>
    pinned ? { type: "leaf", tabs, activeTabIndex, pinned } : { type: "leaf", tabs, activeTabIndex };

  it("pinTab moves the tab to the end of the pinned block and records it", () => {
    const tree = pinTab(leaf(["a", "b", "c"], 2, ["a"]), "c");
    expect(tree).toEqual(leaf(["a", "c", "b"], 1, ["a", "c"]));
  });

  it("pinTab keeps the active tab active when another tab is pinned", () => {
    const tree = pinTab(leaf(["a", "b", "c"], 1), "c");
    expect(tree).toEqual(leaf(["c", "a", "b"], 2, ["c"]));
  });

  it("unpinTab moves the tab to the start of the unpinned block", () => {
    const tree = unpinTab(leaf(["a", "b", "c", "d"], 0, ["a", "b"]), "a");
    expect(tree).toEqual(leaf(["b", "a", "c", "d"], 1, ["b"]));
  });

  it("unpinning the last pinned tab drops the pinned field entirely", () => {
    const tree = unpinTab(leaf(["a", "b"], 0, ["a"]), "a");
    expect(tree).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 });
    expect("pinned" in tree).toBe(false);
  });

  it("isPinned finds the tab anywhere in a split", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      children: [leaf(["a"]), leaf(["b", "c"], 0, ["b"])],
      sizes: [0.5, 0.5],
    };
    expect(isPinned(tree, "b")).toBe(true);
    expect(isPinned(tree, "c")).toBe(false);
    expect(isPinned(tree, "zzz")).toBe(false);
  });

  it("normalizeLeaf drops pinned ids that are not tabs and reorders pinned first", () => {
    const out = normalizeLeaf({ type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 2, pinned: ["c", "ghost"] });
    expect(out).toEqual(leaf(["c", "a", "b"], 0, ["c"]));
  });

  it("closeTab removes the id from pinned too", () => {
    const tree = closeTab(leaf(["a", "b"], 1, ["a"]), "a");
    expect(tree).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });

  it("addTab appends after the pinned block and keeps pinned", () => {
    const tree = addTab(leaf(["a", "b"], 0, ["a"]), "a", "n");
    expect(tree).toEqual(leaf(["a", "b", "n"], 2, ["a"]));
  });

  it("detachTab carries the pinned flag on the detached leaf", () => {
    const result = detachTab(leaf(["a", "b"], 0, ["a"]), "a");
    expect(result?.detached).toEqual(leaf(["a"], 0, ["a"]));
    expect(result?.tree).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });

  it("mergeIntoActivePane puts an incoming pinned tab at the end of the pinned block", () => {
    const target = leaf(["p", "u"], 1, ["p"]);
    const incoming = leaf(["x"], 0, ["x"]) as Extract<LayoutNode, { type: "leaf" }>;
    expect(mergeIntoActivePane(target, "u", incoming)).toEqual(leaf(["p", "x", "u"], 1, ["p", "x"]));
  });

  it("moveTabWithinLeaf clamps a pinned tab inside the pinned block", () => {
    const tree = moveTabWithinLeaf(leaf(["a", "b", "c", "d"], 0, ["a", "b"]), "a", 3);
    // pinned ids are kept in tab order, so the move reorders them too
    expect(tree).toEqual(leaf(["b", "a", "c", "d"], 1, ["b", "a"]));
  });

  it("moveTabWithinLeaf clamps an unpinned tab outside the pinned block", () => {
    const tree = moveTabWithinLeaf(leaf(["a", "b", "c", "d"], 0, ["a", "b"]), "d", 0);
    expect(tree).toEqual(leaf(["a", "b", "d", "c"], 0, ["a", "b"]));
  });

  it("clampReorderIndex bounds by block", () => {
    const l: Leaf = { type: "leaf", tabs: ["a", "b", "c", "d"], activeTabIndex: 0, pinned: ["a", "b"] };
    expect(clampReorderIndex(l, "a", 3)).toBe(1);
    expect(clampReorderIndex(l, "b", 0)).toBe(0);
    expect(clampReorderIndex(l, "d", 0)).toBe(2);
    expect(clampReorderIndex(l, "c", 9)).toBe(3);
  });
});

describe("bulkCloseTargets", () => {
  const tabs = ["p", "a", "b", "c"];
  const pinned = ["p"];
  it("others excludes the clicked tab and pinned tabs", () => {
    expect(bulkCloseTargets(tabs, pinned, "b", "others")).toEqual(["a", "c"]);
  });
  it("right takes only tabs after the clicked one", () => {
    expect(bulkCloseTargets(tabs, pinned, "a", "right")).toEqual(["b", "c"]);
  });
  it("left takes only tabs before the clicked one, never pinned", () => {
    expect(bulkCloseTargets(tabs, pinned, "c", "left")).toEqual(["a", "b"]);
  });
  it("is empty when only pinned neighbours remain", () => {
    expect(bulkCloseTargets(["p", "a"], ["p"], "a", "others")).toEqual([]);
  });
  it("is empty for a tab that is not in the list", () => {
    expect(bulkCloseTargets(tabs, pinned, "ghost", "right")).toEqual([]);
    expect(bulkCloseTargets(tabs, pinned, "ghost", "left")).toEqual([]);
    expect(bulkCloseTargets(tabs, pinned, "ghost", "others")).toEqual([]);
  });
});

describe("presetTiled", () => {
  it("agrees with the hand-written presets at one, two and four panes", () => {
    // There is one right answer to "two side by side" in this app, and a
    // second one drawn slightly differently is a bug nobody would report.
    expect(presetTiled(["a"])).toEqual(presetSingle("a"));
    expect(presetTiled(["a", "b"])).toEqual(presetSideBySide("a", "b"));
    expect(presetTiled(["a", "b", "c", "d"])).toEqual(presetGrid2x2("a", "b", "c", "d"));
  });

  it("keeps three in one row, because three terminals still read", () => {
    const tree = presetTiled(["a", "b", "c"]);
    expect(tree).toEqual({
      type: "split",
      direction: "row",
      children: [presetSingle("a"), presetSingle("b"), presetSingle("c")],
      sizes: [1 / 3, 1 / 3, 1 / 3],
    });
  });

  it("wraps to rows of two beyond three, so no candidate is narrower than its own output", () => {
    const tree = presetTiled(["a", "b", "c", "d", "e"]);
    expect(tree.type).toBe("split");
    const rows = (tree as Extract<LayoutNode, { type: "split" }>).children;
    expect(rows).toHaveLength(3);
    // The odd one out gets a full-width row rather than half a row with a
    // hole in it.
    expect(rows[2]).toEqual(presetSingle("e"));
  });

  it("puts every session in the tree exactly once, at any count", () => {
    for (let n = 1; n <= 9; n++) {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      expect(allSessionIds(presetTiled(ids))).toEqual(ids);
    }
  });
});

describe("paneOwnsActions", () => {
  const split = presetSideBySide("a", "b");
  const left: Leaf = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
  const right: Leaf = { type: "leaf", tabs: ["b"], activeTabIndex: 0 };

  it("gives the row to the focused pane, and to no other", () => {
    expect(paneOwnsActions(split, left, "a")).toBe(true);
    expect(paneOwnsActions(split, right, "a")).toBe(false);
    expect(paneOwnsActions(split, left, "b")).toBe(false);
    expect(paneOwnsActions(split, right, "b")).toBe(true);
  });

  // A pane holds several tabs, and the focus is on ONE of them: the pane
  // owns the row whichever of its own tabs the focus is on, not only when
  // that tab is also the active one.
  it("follows the pane, not the tab", () => {
    const many: Leaf = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 };
    for (const id of many.tabs) {
      expect(paneOwnsActions(many, many, id)).toBe(true);
    }
  });

  // New page lives in this row, so a page that draws it nowhere is a
  // dead end. Both ways the focus can fail to name a pane on this page
  // fall back to the first pane, which is the one resolveFocusForPage
  // would have picked anyway.
  it("falls back to the first pane when nothing on the page holds the focus", () => {
    expect(paneOwnsActions(split, left, null)).toBe(true);
    expect(paneOwnsActions(split, right, null)).toBe(false);
    // A focus left behind on some other page.
    expect(paneOwnsActions(split, left, "elsewhere")).toBe(true);
    expect(paneOwnsActions(split, right, "elsewhere")).toBe(false);
  });

  it("shows them when there is no tree to consult", () => {
    expect(paneOwnsActions(null, left, null)).toBe(true);
    expect(paneOwnsActions(null, right, "a")).toBe(true);
  });

  // The single-pane page, which is most of them: the row is always there.
  it("always gives the only pane its row", () => {
    const only = presetSingle("a") as Leaf;
    expect(paneOwnsActions(only, only, "a")).toBe(true);
    expect(paneOwnsActions(only, only, null)).toBe(true);
    expect(paneOwnsActions(only, only, "elsewhere")).toBe(true);
  });
});

describe("paneLeadsWindow", () => {
  const split = presetSideBySide("a", "b");
  const left: Leaf = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
  const right: Leaf = { type: "leaf", tabs: ["b"], activeTabIndex: 0 };

  // The window's own chrome sits in the window's corner, so the pane
  // that draws it is the top-left one -- the first in tree order, which
  // is what allSessionIds walks.
  it("gives the window's chrome to the first pane on the page", () => {
    expect(paneLeadsWindow(split, left)).toBe(true);
    expect(paneLeadsWindow(split, right)).toBe(false);
  });

  // The whole difference from paneOwnsActions: the focus can move
  // anywhere on the page and the corner does not.
  it("does not follow the focus, however the page is split", () => {
    const grid = presetGrid2x2("a", "b", "c", "d");
    const topLeft: Leaf = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const bottomRight: Leaf = { type: "leaf", tabs: ["d"], activeTabIndex: 0 };
    expect(paneLeadsWindow(grid, topLeft)).toBe(true);
    expect(paneLeadsWindow(grid, bottomRight)).toBe(false);
    // Same answers with the focus parked in the far pane: there is no
    // focus argument to give it, by design.
    expect(paneOwnsActions(grid, bottomRight, "d")).toBe(true);
    expect(paneLeadsWindow(grid, bottomRight)).toBe(false);
  });

  // The collapse toggle is the only way back from a collapsed rail, so
  // the chrome can never go missing entirely.
  it("shows the chrome when there is no tree, and on the only pane", () => {
    expect(paneLeadsWindow(null, left)).toBe(true);
    const only = presetSingle("a") as Leaf;
    expect(paneLeadsWindow(only, only)).toBe(true);
  });
});
