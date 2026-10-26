import { describe, expect, it } from "vitest";
import { HUB_VIEW_META, tabStripHubViewIds, visibleHubViewIds } from "$lib/hub/hubViewMeta";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";
import { source } from "$lib/sources";

// The Log tab's wiring, read from source (scheduledSurfaces.test.ts's
// reason): a tab with no component crashes at render, a gate nobody
// consumes is a dead gate, and a push listened for under a name the host
// never emits is a tab that never goes live.

const RUST = import.meta.glob("../../../src-tauri/src/session.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const session = Object.values(RUST)[0];

describe("the tab's registration", () => {
  it("is a hub tab that needs a root, right after Scheduled", () => {
    const meta = HUB_VIEW_META.find((v) => v.id === "log");
    expect(meta).toMatchObject({ label: "Log", requiresRoot: true });
    expect(tabStripHubViewIds(true)).toContain("log");
    expect(visibleHubViewIds(false)).not.toContain("log");
    const ids = HUB_VIEW_META.map((v) => v.id);
    expect(ids.indexOf("log")).toBe(ids.indexOf("scheduled") + 1);
  });

  it("has a component bound to its id", () => {
    expect(source("workspaceViews.ts")).toContain("log: { icon: ScrollText, component: WorkspaceLogHubView }");
  });
});

describe("the surface", () => {
  const view = source("WorkspaceLogHubView.svelte");
  const state = source("workspaceLogState.ts");

  it("says to restart an older daemon rather than drawing an empty log", () => {
    expect(FEATURE_MIN_VERSION.workspaceLog).toBe(79);
    expect(state).toContain('featureBlockedReason(get(daemonCompat), "workspaceLog")');
    expect(view).toContain("workspaceLogBlockedReason(workspaceId)");
    expect(view).toMatch(/\{#if blocked\}\s*<div class="empty">\{blocked\}<\/div>/);
  });

  it("asks before clearing, as a danger, with a button that names the action", () => {
    expect(state).toContain("askConfirm({ ...ask, danger: true })");
    expect(view).toContain("Clear older than…");
  });

  it("guards its reads with a token, never by identity", () => {
    expect(view).toContain("const mine = ++token;");
    expect(view).toContain("if (mine !== token) return;");
  });

  it("opens a card the way the calendar and the inbox do", () => {
    expect(view).toContain("openRunCard(workspaceId, target.path)");
    expect(view).toContain("gone — deleted");
  });

  it("listens for the push under the name the host emits it with", () => {
    expect(state).toContain('listen<[string, LogEntry[]]>("workspace-log-appended"');
    expect(session).toContain('emit(&reader_app_handle, "workspace-log-appended", (workspace_id, entries))');
  });

  it("offers the filter, the search and every clear span", () => {
    expect(view).toContain('role="menuitemcheckbox"');
    expect(view).toContain("<SearchInput");
    expect(view).toContain("clearOptions(now)");
  });
});
