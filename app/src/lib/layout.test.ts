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
} from "./layout";
import type { LayoutNode } from "./layout";

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
