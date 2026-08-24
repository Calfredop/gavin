import { describe, it, expect } from "vitest";
import { HUB_VIEW_META, visibleHubViewIds, resolveHubView, hubViewBusy } from "./hubViewMeta";
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

describe("hubViewBusy", () => {
  it("spins the Git tab, and only the Git tab, while a commit run is in flight", () => {
    expect(hubViewBusy("git", { committing: true })).toBe(true);
    for (const other of HUB_VIEW_META.filter((v) => v.id !== "git")) {
      expect(hubViewBusy(other.id, { committing: true })).toBe(false);
    }
  });

  it("leaves every tab alone when nothing is running", () => {
    for (const view of HUB_VIEW_META) {
      expect(hubViewBusy(view.id, { committing: false })).toBe(false);
    }
  });
});
