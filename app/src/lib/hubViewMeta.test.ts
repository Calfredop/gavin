import { describe, it, expect } from "vitest";
import { HUB_VIEW_META, visibleHubViewIds } from "./hubViewMeta";
import { SMOKETEST_WORKSPACE_ID } from "./workspace";

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

