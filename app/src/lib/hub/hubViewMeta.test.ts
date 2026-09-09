import { describe, it, expect } from "vitest";
import {
  HUB_VIEW_META,
  visibleHubViewIds,
  tabStripHubViewIds,
  resolveHubView,
  hubViewBusy,
  hubViewAttention,
  orderableHubViewIds,
  manageableHubViewIds,
  orderHubViewIds,
  moveHubViewId,
  toggleHubViewHidden,
  canHideHubView,
} from "$lib/hub/hubViewMeta";
import { type Workspace } from "$lib/core/workspace";

describe("visibleHubViewIds", () => {
  it("keeps the declaration order", () => {
    const ids = visibleHubViewIds(true);
    expect(ids).toEqual(HUB_VIEW_META.map((v) => v.id));
    expect(ids[0]).toBe("home");
  });

  it("drops root-only views for an unbound workspace", () => {
    const ids = visibleHubViewIds(false);
    expect(ids).not.toContain("home");
    expect(ids).toContain("kanban");
    expect(ids).toContain("settings");
  });
});


describe("tabStripHubViewIds", () => {
  // Settings is still OFFERED -- switchWorkspaceView opens it, a
  // workspace remembers landing on it -- it just has no tab. The gear in
  // the hub row's actions is where it is reached from.
  it("drops the views reached by a button, keeping every other one", () => {
    const ids = tabStripHubViewIds(true);
    expect(ids).not.toContain("settings");
    expect(visibleHubViewIds(true)).toContain("settings");
    expect(ids).toEqual(visibleHubViewIds(true).filter((id) => id !== "settings"));
  });

  // The ⌘-digit router counts along this list, so it has to be the same
  // list the strip renders -- and it still has to obey the same
  // visibility rules, or a digit would open a tab that is not offered.
  it("keeps the strip order and the same visibility rules", () => {
    expect(tabStripHubViewIds(true)[0]).toBe("home");
    expect(tabStripHubViewIds(false)).not.toContain("home");
  });

  // An unrooted workspace offered Kanban and Settings; take the tab away
  // and Kanban is the only one left. A strip that could empty would be a
  // row of nothing at the top of the window.
  it("never empties a workspace's strip", () => {
    expect(tabStripHubViewIds(false)).toEqual(["kanban"]);
  });
});

describe("orderableHubViewIds / manageableHubViewIds", () => {
  it("leaves the button-reached views out of both", () => {
    expect(orderableHubViewIds()).not.toContain("settings");
    expect(manageableHubViewIds()).not.toContain("settings");
  });
});

describe("orderHubViewIds", () => {
  it("leaves the declaration order alone when nothing is stored", () => {
    const ids = ["home", "git", "kanban"];
    expect(orderHubViewIds(ids, null)).toEqual(ids);
    expect(orderHubViewIds(ids, [])).toEqual(ids);
  });

  it("draws the stored order", () => {
    expect(orderHubViewIds(["home", "git", "kanban"], ["kanban", "home", "git"])).toEqual([
      "kanban",
      "home",
      "git",
    ]);
  });

  // A tab this gavin has and the stored order does not: it must land
  // somewhere predictable rather than at a position nobody chose.
  it("puts ids the order never mentions last, in declaration order", () => {
    expect(orderHubViewIds(["home", "git", "kanban", "plans"], ["kanban"])).toEqual([
      "kanban",
      "home",
      "git",
      "plans",
    ]);
  });

  it("ignores ids the order mentions but this workspace does not offer", () => {
    expect(orderHubViewIds(["kanban"], ["git", "kanban", "home"])).toEqual(["kanban"]);
  });
});

describe("moveHubViewId", () => {
  const natural = orderableHubViewIds();

  it("drops the tab before or after the one it was dropped on", () => {
    expect(moveHubViewId(null, "kanban", "home", "before")[0]).toBe("kanban");
    expect(moveHubViewId(null, "kanban", "home", "after").slice(0, 2)).toEqual(["home", "kanban"]);
  });

  // The strip a drag happens in may be showing four of nine tabs. Storing
  // only those four would forget where the rest sat the moment a root was
  // bound, so the result always covers every orderable id.
  it("returns a full order over every orderable id", () => {
    const moved = moveHubViewId(null, "files", "home", "before");
    expect([...moved].sort()).toEqual([...natural].sort());
  });

  it("is a no-op when a tab is dropped on itself", () => {
    expect(moveHubViewId(null, "git", "git", "before")).toEqual(natural);
  });

  it("builds on the order already stored", () => {
    const first = moveHubViewId(null, "kanban", "home", "before");
    const second = moveHubViewId(first, "plans", "kanban", "before");
    expect(second.slice(0, 2)).toEqual(["plans", "kanban"]);
  });
});

describe("toggleHubViewHidden", () => {
  it("flips one id, starting from nothing hidden", () => {
    expect(toggleHubViewHidden(null, "git")).toEqual(["git"]);
    expect(toggleHubViewHidden(["git"], "git")).toEqual([]);
    expect(toggleHubViewHidden(["git"], "prd")).toEqual(["git", "prd"]);
  });
});

describe("canHideHubView", () => {
  it("refuses to take away the last section left", () => {
    const allButKanban = manageableHubViewIds().filter((id) => id !== "kanban");
    expect(canHideHubView(allButKanban, "kanban")).toBe(false);
    // Turning one back ON is always allowed, even from that state.
    expect(canHideHubView(allButKanban, "git")).toBe(true);
  });

  it("allows any hide while more than one is showing", () => {
    expect(canHideHubView(null, "git")).toBe(true);
    expect(canHideHubView(["git"], "prd")).toBe(true);
  });
});

describe("tabStripHubViewIds with preferences", () => {
  it("draws the human's order", () => {
    const ids = tabStripHubViewIds(true, {
      order: ["kanban", "git"],
      hidden: null,
    });
    expect(ids.slice(0, 2)).toEqual(["kanban", "git"]);
    expect(ids).toContain("home");
  });

  it("drops the hidden ones", () => {
    const ids = tabStripHubViewIds(true, { order: null, hidden: ["git", "prd"] });
    expect(ids).not.toContain("git");
    expect(ids).not.toContain("prd");
    expect(ids).toContain("home");
  });

  // The panels refuse to hide the last MANAGEABLE view, but that is a
  // statement about the whole list: the root gate has already cut this
  // strip down, so a legal hidden set can still empty one workspace.
  it("ignores a hidden set that would empty this workspace's strip", () => {
    expect(tabStripHubViewIds(false, { order: null, hidden: ["kanban"] })).toEqual([
      "kanban",
    ]);
  });

  it("keeps counting the same list the strip draws", () => {
    const prefs = { order: ["files", "kanban"], hidden: ["home"] };
    const ids = tabStripHubViewIds(true, prefs);
    expect(ids[0]).toBe("files");
    expect(ids[1]).toBe("kanban");
    expect(ids).not.toContain("home");
  });
});

describe("resolveHubView", () => {
  function workspace(fields: Partial<Workspace>): Workspace {
    return { id: "ws-1", name: "A", pages: [], activePageId: null, rootPath: "/tmp/ws", ...fields };
  }

  it("reopens the hub tab the workspace was last showing", () => {
    expect(resolveHubView(workspace({ hubView: "kanban" }))).toBe("kanban");
  });

  it("falls back to the first offered tab when nothing is remembered yet", () => {
    expect(resolveHubView(workspace({}))).toBe("home");
  });

  it("falls back when the remembered tab is no longer offered", () => {
    // A workspace whose root was never bound is offered neither Git nor
    // Home, so a remembered "git" would land on a tab that isn't there.
    expect(resolveHubView(workspace({ hubView: "git", rootPath: undefined }))).toBe("kanban");
  });

  it("falls back when the remembered tab has been hidden", () => {
    expect(
      resolveHubView(workspace({ hubView: "git" }), { order: null, hidden: ["git"] })
    ).toBe("home");
  });

  it("lands on the first tab of the human's own order", () => {
    expect(resolveHubView(workspace({}), { order: ["plans"], hidden: null })).toBe("plans");
  });

  // Hiding cannot reach a view that has no tab, so a workspace parked on
  // Settings stays there however the strip is arranged.
  it("keeps a button-reached view even though it is not in the strip", () => {
    expect(
      resolveHubView(workspace({ hubView: "settings" }), {
        order: null,
        hidden: ["git", "prd"],
      })
    ).toBe("settings");
  });
});

const IDLE = { committing: false, railsWantingAttention: false };

describe("hubViewBusy", () => {
  it("spins the Git tab, and only the Git tab, while a commit run is in flight", () => {
    expect(hubViewBusy("git", { ...IDLE, committing: true })).toBe(true);
    for (const other of HUB_VIEW_META.filter((v) => v.id !== "git")) {
      expect(hubViewBusy(other.id, { ...IDLE, committing: true })).toBe(false);
    }
  });

  it("leaves every tab alone when nothing is running", () => {
    for (const view of HUB_VIEW_META) {
      expect(hubViewBusy(view.id, IDLE)).toBe(false);
    }
  });
});

describe("hubViewAttention", () => {
  it("marks the Orchestration tab, and only it, when a rail wants a human", () => {
    expect(hubViewAttention("orchestration", { ...IDLE, railsWantingAttention: true })).toBe(true);
    for (const other of HUB_VIEW_META.filter((v) => v.id !== "orchestration")) {
      expect(hubViewAttention(other.id, { ...IDLE, railsWantingAttention: true })).toBe(false);
    }
  });

  it("leaves every tab alone when no rail wants anything", () => {
    for (const view of HUB_VIEW_META) {
      expect(hubViewAttention(view.id, IDLE)).toBe(false);
    }
  });

  // The two axes are independent and must not be collapsed: a spinner
  // says gavin is doing something, a mark says the human has to.
  it("is separate from busy -- a committing Git tab wants nothing from you", () => {
    const activity = { committing: true, railsWantingAttention: false };
    expect(hubViewBusy("git", activity)).toBe(true);
    expect(hubViewAttention("git", activity)).toBe(false);
  });
});
