import { describe, it, expect } from "vitest";
import {
  followUpsSessionFor,
  isViewTab,
  renameable,
  tabKind,
  tabLabel,
  tabTooltip,
  type TabNaming,
} from "$lib/panes/tabIdentity";
import type { GavinTree } from "$lib/core/gavin";

function ctx(over: Partial<TabNaming> = {}): TabNaming {
  return {
    fileTabsById: {},
    boardTabsById: {},
    cardTabsById: {},
    sessionNames: {},
    cwdBySessionId: {},
    trees: {},
    orchestrations: {},
    ...over,
  };
}

const tree = (name: string, folderPath: string): Record<string, GavinTree> => ({
  ws: {
    rootPath: "/ws/.gavin-root",
    rootMissing: false,
    contexts: [
      {
        name,
        folderPath,
        plans: [],
      },
    ],
  } as unknown as GavinTree,
});

describe("tabKind", () => {
  it("calls a tab in none of the maps a terminal", () => {
    // The load-bearing clause: an id is a session by ABSENCE, so a lost
    // map entry reads as a terminal rather than as a missing tab.
    expect(tabKind("s1", ctx())).toBe("terminal");
  });

  it("reads each map's own kind", () => {
    expect(tabKind("b", ctx({ boardTabsById: { b: { workspaceId: "ws", contextFolder: "/ws" } } }))).toBe("board");
    expect(tabKind("f", ctx({ fileTabsById: { f: { path: "/ws/a.txt" } } }))).toBe("file");
    expect(
      tabKind("c", ctx({ cardTabsById: { c: { workspaceId: "ws", path: "/ws/p.md", view: "plan" } } }))
    ).toBe("card");
  });

  // A queue is a card tab with no card: its subject rides in sessionId,
  // because an agent's queue outlives whatever card it is running.
  it("calls a followups card tab a queue", () => {
    const c = ctx({ cardTabsById: { q: { workspaceId: "ws", path: "", view: "followups", sessionId: "s1" } } });
    expect(tabKind("q", c)).toBe("followups");
    expect(followUpsSessionFor("q", c)).toBe("s1");
  });

  it("has no queue session for any other tab", () => {
    expect(followUpsSessionFor("s1", ctx())).toBeNull();
    expect(
      followUpsSessionFor("c", ctx({ cardTabsById: { c: { workspaceId: "ws", path: "/p.md", view: "plan" } } }))
    ).toBeNull();
  });
});

describe("isViewTab / renameable", () => {
  // Every session chip in the tab bar opens with this check: a card pane
  // offering to open a card pane beside itself is what dropping it does.
  it("is true for every kind but a terminal, and renameable is its inverse", () => {
    const maps = [
      ctx({ boardTabsById: { t: { workspaceId: "ws", contextFolder: "/ws" } } }),
      ctx({ fileTabsById: { t: { path: "/a.txt" } } }),
      ctx({ cardTabsById: { t: { workspaceId: "ws", path: "/p.md", view: "plan" } } }),
      ctx({ cardTabsById: { t: { workspaceId: "ws", path: "", view: "followups", sessionId: "s" } } }),
    ];
    for (const c of maps) {
      expect(isViewTab("t", c)).toBe(true);
      expect(renameable("t", c)).toBe(false);
    }
    expect(isViewTab("t", ctx())).toBe(false);
    expect(renameable("t", ctx())).toBe(true);
  });
});

describe("tabLabel", () => {
  it("names a board tab after its context, live from the tree", () => {
    const c = ctx({
      boardTabsById: { b: { workspaceId: "ws", contextFolder: "/ws/app" } },
      trees: tree("app", "/ws/app"),
    });
    expect(tabLabel("b", c)).toContain("app");
  });

  // A context the tree does not know yet still has to draw something --
  // the folder is the fallback, and boardTabLabel owns that choice.
  it("falls back to the folder for a context the tree has not answered for", () => {
    const c = ctx({ boardTabsById: { b: { workspaceId: "ws", contextFolder: "/ws/app" } } });
    expect(tabLabel("b", c)).not.toBe("b");
  });

  it("names a file tab after its file", () => {
    expect(tabLabel("f", ctx({ fileTabsById: { f: { path: "/ws/src/main.rs" } } }))).toBe("main.rs");
  });

  // The queue is named after the terminal it belongs to, not after a
  // card, because it has none.
  it("names a queue after its terminal", () => {
    const c = ctx({
      cardTabsById: { q: { workspaceId: "ws", path: "", view: "followups", sessionId: "s1" } },
      sessionNames: { s1: "builder" },
    });
    expect(tabLabel("q", c)).toContain("builder");
  });

  it("falls back to a terminal's cwd, then to the id itself", () => {
    expect(tabLabel("s1", ctx({ sessionNames: { s1: "named" } }))).toBe("named");
    expect(tabLabel("s1", ctx({ cwdBySessionId: { s1: "/ws/project" } }))).toBe("project");
    expect(tabLabel("s1", ctx())).toBe("s1");
  });
});

describe("tabTooltip", () => {
  it("points at the folder, path or file the label had to drop", () => {
    expect(tabTooltip("b", ctx({ boardTabsById: { b: { workspaceId: "ws", contextFolder: "/ws/app" } } }))).toBe(
      "/ws/app"
    );
    expect(
      tabTooltip("c", ctx({ cardTabsById: { c: { workspaceId: "ws", path: "/ws/p.md", view: "plan" } } }))
    ).toBe("/ws/p.md");
    expect(tabTooltip("f", ctx({ fileTabsById: { f: { path: "/ws/a.txt" } } }))).toBe("/ws/a.txt");
  });

  // Where a queue points IS its terminal, so it borrows that tooltip
  // rather than inventing one.
  it("borrows the terminal's tooltip for a queue", () => {
    const c = ctx({
      cardTabsById: { q: { workspaceId: "ws", path: "", view: "followups", sessionId: "s1" } },
      cwdBySessionId: { s1: "/ws/project" },
    });
    expect(tabTooltip("q", c)).toBe("/ws/project");
  });

  it("falls back to the terminal's name, cwd, then the id", () => {
    expect(tabTooltip("s1", ctx({ sessionNames: { s1: "builder" } }))).toBe("builder");
    expect(tabTooltip("s1", ctx({ cwdBySessionId: { s1: "/ws" } }))).toBe("/ws");
    expect(tabTooltip("s1", ctx())).toBe("s1");
  });
});
