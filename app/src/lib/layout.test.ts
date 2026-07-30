import { describe, it, expect } from "vitest";
import {
  findLeafPath,
  getNodeAtPath,
  splitLeaf,
  addTab,
  closeTab,
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
