import { describe, it, expect } from "vitest";
import {
  HUB_VIEW_META,
  visibleHubViewIds,
  resolveHubView,
  hubViewBusy,
  hubViewAttention,
} from "./hubViewMeta";
import { SMOKETEST_WORKSPACE_ID, type Workspace } from "./workspace";

describe("visibleHubViewIds", () => {
  it("keeps the declaration order", () => {
    const ids = visibleHubViewIds("ws-1", false, true);
    expect(ids).toEqual(HUB_VIEW_META.filter((v) => !v.devOnly).map((v) => v.id));
    expect(ids[0]).toBe("home");
  });

  it("drops root-only views for an unbound workspace", () => {
    const ids = visibleHubViewIds("ws-1", false, false);
    expect(ids).not.toContain("home");
    expect(ids).toContain("kanban");
    expect(ids).toContain("settings");
  });

  it("offers the dev-only checklist only in the smoke-test workspace of a dev build", () => {
    expect(visibleHubViewIds(SMOKETEST_WORKSPACE_ID, true, true)).toContain("checklist");
    expect(visibleHubViewIds("ws-1", true, true)).not.toContain("checklist");
    expect(visibleHubViewIds(SMOKETEST_WORKSPACE_ID, false, true)).not.toContain("checklist");
  });
});


describe("resolveHubView", () => {
  function workspace(fields: Partial<Workspace>): Workspace {
    return { id: "ws-1", name: "A", pages: [], activePageId: null, rootPath: "/tmp/ws", ...fields };
  }

  it("reopens the hub tab the workspace was last showing", () => {
    expect(resolveHubView(workspace({ hubView: "kanban" }), false)).toBe("kanban");
  });

  it("falls back to the first offered tab when nothing is remembered yet", () => {
    expect(resolveHubView(workspace({}), false)).toBe("home");
  });

  it("falls back when the remembered tab is no longer offered", () => {
    // A workspace whose root was never bound is offered neither Git nor
    // Home, so a remembered "git" would land on a tab that isn't there.
    expect(resolveHubView(workspace({ hubView: "git", rootPath: undefined }), false)).toBe("kanban");
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
