import { describe, it, expect } from "vitest";
import {
  attachedViewsIn,
  boardSubject,
  cardSubject,
  chipPress,
  sidePaneFor,
  sideShareAt,
  groupTooltip,
  openAnchorFor,
  openViewOf,
  placeViewOpen,
  showsSubject,
  type ViewSubject,
} from "$lib/panes/attachedViews";
import { attachView, type LayoutNode, type Leaf } from "$lib/panes/layout";
import type { TabMaps } from "$lib/panes/tabIdentity";

const PLAN: ViewSubject = { kind: "card", tab: { workspaceId: "ws", path: "/p.md", view: "plan" } };
const DIFF: ViewSubject = { kind: "card", tab: { workspaceId: "ws", path: "/p.md", view: "changes" } };

function maps(partial: Partial<TabMaps> = {}): TabMaps {
  return { fileTabsById: {}, boardTabsById: {}, cardTabsById: {}, ...partial };
}

const pane = (tabs: string[], active = 0): Leaf => ({ type: "leaf", tabs, activeTabIndex: active });

// (a) owns a plan and a diff, diff in front; (b) owns nothing.
function grouped(): { tree: LayoutNode; maps: TabMaps } {
  const tree = attachView(attachView(pane(["a", "b"]), "a", "plan-1"), "a", "diff-1");
  return {
    tree,
    maps: maps({
      cardTabsById: {
        "plan-1": { workspaceId: "ws", path: "/p.md", view: "plan" },
        "diff-1": { workspaceId: "ws", path: "/p.md", view: "changes" },
      },
    }),
  };
}

describe("showsSubject", () => {
  it("matches a card view on workspace, path, view and session alike", () => {
    const m = maps({
      cardTabsById: {
        q: { workspaceId: "ws", path: "", view: "followups", sessionId: "a" },
        p: { workspaceId: "ws", path: "/p.md", view: "plan" },
      },
    });
    expect(showsSubject("p", PLAN, m)).toBe(true);
    expect(showsSubject("p", DIFF, m)).toBe(false);
    const queue = (sessionId: string): ViewSubject => ({
      kind: "card",
      tab: { workspaceId: "ws", path: "", view: "followups", sessionId },
    });
    expect(showsSubject("q", queue("a"), m)).toBe(true);
    expect(showsSubject("q", queue("b"), m)).toBe(false);
  });

  it("matches a file by path and a board by its context", () => {
    const m = maps({
      fileTabsById: { f: { path: "/x.md" } },
      boardTabsById: { k: { workspaceId: "ws", contextFolder: "/ws/auth" } },
    });
    expect(showsSubject("f", { kind: "file", path: "/x.md" }, m)).toBe(true);
    expect(showsSubject("f", { kind: "file", path: "/y.md" }, m)).toBe(false);
    expect(showsSubject("k", { kind: "board", tab: { workspaceId: "ws", contextFolder: "/ws/auth" } }, m)).toBe(true);
    expect(showsSubject("k", { kind: "file", path: "/x.md" }, m)).toBe(false);
  });
});

describe("placeViewOpen", () => {
  it("attaches beside a terminal tab, and finds an open view of the same thing in its group", () => {
    const { tree, maps: m } = grouped();
    expect(placeViewOpen(tree, "a", PLAN, m)).toEqual({ kind: "attach", ownerId: "a", existingId: "plan-1" });
    expect(placeViewOpen(tree, "a", { kind: "file", path: "/x" }, m)).toEqual({
      kind: "attach",
      ownerId: "a",
      existingId: null,
    });
  });

  it("looks in the anchor's group only, not across the pane", () => {
    const { tree, maps: m } = grouped();
    expect(placeViewOpen(tree, "b", PLAN, m)).toEqual({ kind: "attach", ownerId: "b", existingId: null });
  });

  it("an anchor inside a group stands for the group's owner", () => {
    const { tree, maps: m } = grouped();
    expect(placeViewOpen(tree, "diff-1", PLAN, m)).toEqual({ kind: "attach", ownerId: "a", existingId: "plan-1" });
  });

  it("falls back to a page split beside an ordinary view tab, with the old card de-duplication", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      children: [pane(["file-1"]), pane(["plan-old"])],
      sizes: [0.5, 0.5],
    };
    const m = maps({
      fileTabsById: { "file-1": { path: "/x" } },
      cardTabsById: { "plan-old": { workspaceId: "ws", path: "/p.md", view: "plan" } },
    });
    expect(placeViewOpen(tree, "file-1", PLAN, m)).toEqual({
      kind: "split",
      anchorId: "file-1",
      existingId: "plan-old",
    });
    expect(placeViewOpen(tree, "file-1", { kind: "file", path: "/x" }, m)).toEqual({
      kind: "split",
      anchorId: "file-1",
      existingId: null,
    });
  });

  it("is null for an anchor the tree does not hold", () => {
    expect(placeViewOpen(pane(["a"]), "nope", PLAN, maps())).toBeNull();
  });
});

describe("openViewOf", () => {
  it("names the group's view of a subject -- what lights its chip", () => {
    const { tree, maps: m } = grouped();
    expect(openViewOf(tree, "a", PLAN, m)).toBe("plan-1");
    expect(openViewOf(tree, "b", PLAN, m)).toBeNull();
    expect(openViewOf(null, "a", PLAN, m)).toBeNull();
  });
});

describe("chipPress", () => {
  it("closes the view only while it is in front, its owner the pane's active tab", () => {
    const { tree, maps: m } = grouped();
    expect(chipPress(tree, "a", DIFF, m)).toEqual({ kind: "close", viewId: "diff-1" });
    // Open but behind the diff: the press brings it forward.
    expect(chipPress(tree, "a", PLAN, m)).toEqual({ kind: "open" });
  });

  it("opens when the owner is not in front, even if its view is", () => {
    const { tree, maps: m } = grouped();
    const onB = { ...(tree as Leaf), activeTabIndex: 1 };
    expect(chipPress(onB, "a", DIFF, m)).toEqual({ kind: "open" });
  });

  it("opens when nothing is open yet", () => {
    expect(chipPress(pane(["a"]), "a", PLAN, maps())).toEqual({ kind: "open" });
    expect(chipPress(null, "a", PLAN, maps())).toEqual({ kind: "open" });
  });
});

describe("openAnchorFor", () => {
  it("anchors to a focused terminal, or to the owner of a focused view", () => {
    const { tree, maps: m } = grouped();
    expect(openAnchorFor("a", tree, m)).toBe("a");
    expect(openAnchorFor("diff-1", tree, m)).toBe("a");
  });

  it("has nothing to anchor to on an ordinary view tab, or with no focus", () => {
    const m = maps({ fileTabsById: { f: { path: "/x" } } });
    expect(openAnchorFor("f", pane(["a", "f"]), m)).toBeNull();
    expect(openAnchorFor(null, pane(["a"]), m)).toBeNull();
  });
});

describe("groupTooltip", () => {
  it("names a tab's views in strip order, and nothing for a tab without", () => {
    const { tree } = grouped();
    const labels: Record<string, string> = { "plan-1": "Plan", "diff-1": "Changes" };
    expect(groupTooltip(tree as Leaf, "a", (id) => labels[id])).toBe("Plan · Changes");
    expect(groupTooltip(tree as Leaf, "b", (id) => labels[id])).toBeNull();
  });
});

describe("the side pane", () => {
  it("is the active tab's group, and nothing for a tab without one", () => {
    const { tree } = grouped();
    expect(sidePaneFor(tree as Leaf)).toEqual({ ownerId: "a", views: ["plan-1", "diff-1"], front: "diff-1", size: 0.5 });
    expect(sidePaneFor({ ...(tree as Leaf), activeTabIndex: 1 })).toBeNull();
  });

  it("keeps every group's views listed with their owner, so each stays mounted", () => {
    const tree = attachView(grouped().tree, "b", "file-1") as Leaf;
    expect(attachedViewsIn(tree)).toEqual([
      { id: "plan-1", ownerId: "a" },
      { id: "diff-1", ownerId: "a" },
      { id: "file-1", ownerId: "b" },
    ]);
  });

  it("measures the divider from the body's right edge", () => {
    expect(sideShareAt({ left: 100, width: 400 }, 400)).toBe(0.25);
    expect(sideShareAt({ left: 0, width: 0 }, 10)).toBe(0.5);
  });

  it("builds the chips' subjects keyed as the opens record them", () => {
    expect(cardSubject("ws", "/p.md", "plan")).toEqual(PLAN);
    expect(cardSubject("ws", "", "browser", "a")).toEqual({
      kind: "card",
      tab: { workspaceId: "ws", path: "", view: "browser", sessionId: "a" },
    });
    expect(boardSubject("ws", "/ws/auth")).toEqual({
      kind: "board",
      tab: { workspaceId: "ws", contextFolder: "/ws/auth" },
    });
  });
});
