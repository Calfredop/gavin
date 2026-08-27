import { describe, it, expect } from "vitest";
import type { LayoutNode } from "./layout";
import {
  createWorkspace,
  renameWorkspace,
  switchWorkspace,
  removeWorkspace,
  reorderWorkspace,
  createPage,
  renamePage,
  switchPage,
  removePage,
  movePage,
  updatePageLayout,
  getActiveWorkspace,
  getActivePage,
  getActiveTree,
  getActiveView,
  hubViewIsOnScreen,
  switchWorkspaceView,
  allSessionIdsInWorkspace,
  findSessionLocation,
  resolveFocusForPage,
  setPageFocus,
  resolveActiveFocus,
  UNFILED_WORKSPACE_ID,
  SMOKETEST_WORKSPACE_ID,
  showsDevOnlyViews,
  hubViewIsVisible,
  sidebarWorkspaceOrder,
  type WorkspacesData,
  type Workspace,
  type Page,
  hubLabel,
  workspaceIdForSession,
  rememberRemoved,
  matchTombstone,
  forgetTombstone,
  reclaimable,
  restoreWorkspaceId,
  REMOVED_WORKSPACES_LIMIT,
} from "./workspace";

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

const empty: WorkspacesData = { workspaces: [], activeWorkspaceId: null };

describe("createWorkspace", () => {
  it("appends a new empty workspace and makes it active", () => {
    const state = createWorkspace(empty, "ws-1", "My Project");
    expect(state.workspaces).toEqual([{ id: "ws-1", name: "My Project", pages: [], activePageId: null }]);
    expect(state.activeWorkspaceId).toBe("ws-1");
  });
});

describe("renameWorkspace", () => {
  it("updates only the matching workspace's name", () => {
    const state = createWorkspace(createWorkspace(empty, "ws-1", "A"), "ws-2", "B");
    const renamed = renameWorkspace(state, "ws-1", "A renamed");
    expect(renamed.workspaces.map((w) => w.name)).toEqual(["A renamed", "B"]);
  });
});

describe("switchWorkspace", () => {
  it("makes the target active and stamps only it", () => {
    const state = createWorkspace(createWorkspace(empty, "ws-1", "A"), "ws-2", "B");
    const switched = switchWorkspace(state, "ws-1", 1000);
    expect(switched.activeWorkspaceId).toBe("ws-1");
    expect(switched.workspaces.map((w) => w.lastActiveAt)).toEqual([1000, undefined]);
  });

  it("leaves every other field of the switched-to workspace alone", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const switched = switchWorkspace(state, "ws-1", 1000);
    expect({ ...switched.workspaces[0], lastActiveAt: undefined }).toEqual({
      ...state.workspaces[0],
      lastActiveAt: undefined,
    });
  });

  it("overwrites an earlier stamp rather than keeping the first visit", () => {
    const first = switchWorkspace(createWorkspace(empty, "ws-1", "A"), "ws-1", 1000);
    const second = switchWorkspace(first, "ws-1", 5000);
    expect(second.workspaces[0].lastActiveAt).toBe(5000);
  });

  it("still sets an unknown id active, stamping nothing", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const switched = switchWorkspace(state, "gone", 1000);
    expect(switched.activeWorkspaceId).toBe("gone");
    expect(switched.workspaces[0].lastActiveAt).toBeUndefined();
  });
});

describe("getActiveView", () => {
  it("defaults to terminal when activeView is unset", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    expect(getActiveView(state.workspaces[0])).toBe("terminal");
  });

  it("returns the workspace's own activeView when set", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const w = { ...state.workspaces[0], activeView: "kanban" };
    expect(getActiveView(w)).toBe("kanban");
  });

  it("defaults a rooted workspace to home", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const w = { ...state.workspaces[0], rootPath: "/tmp/ws" };
    expect(getActiveView(w)).toBe("home");
  });

  it("still honours an explicit view on a rooted workspace", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const w = { ...state.workspaces[0], rootPath: "/tmp/ws", activeView: "terminal" };
    expect(getActiveView(w)).toBe("terminal");
  });
});

describe("hubViewIsOnScreen", () => {
  const twoRooted = (): WorkspacesData => {
    const state = createWorkspace(createWorkspace(empty, "ws-1", "A"), "ws-2", "B");
    return { ...state, workspaces: state.workspaces.map((w) => ({ ...w, rootPath: "/tmp/" + w.id })) };
  };

  it("is true only for the active workspace's own current view", () => {
    const state = switchWorkspaceView(switchWorkspace(twoRooted(), "ws-1", 1000), "ws-1", "git");
    expect(hubViewIsOnScreen(state, "ws-1", "git")).toBe(true);
    expect(hubViewIsOnScreen(state, "ws-1", "kanban")).toBe(false);
  });

  // The tab a background workspace is parked on is showing nothing at
  // all -- another workspace's tabs are what fill the window.
  it("is false for a workspace parked on that view while another is active", () => {
    const state = switchWorkspace(switchWorkspaceView(twoRooted(), "ws-2", "git"), "ws-1", 1000);
    expect(hubViewIsOnScreen(state, "ws-2", "git")).toBe(false);
  });

  it("honours the default view of a workspace that has never chosen one", () => {
    const state = switchWorkspace(twoRooted(), "ws-1", 1000);
    expect(hubViewIsOnScreen(state, "ws-1", "home")).toBe(true);
    expect(hubViewIsOnScreen(state, "ws-1", "git")).toBe(false);
  });

  it("is false for a workspace that no longer exists", () => {
    const state = { ...twoRooted(), activeWorkspaceId: "gone" };
    expect(hubViewIsOnScreen(state, "gone", "git")).toBe(false);
  });
});

describe("switchWorkspaceView", () => {
  it("sets the given workspace's activeView, leaving others untouched", () => {
    const state = createWorkspace(createWorkspace(empty, "ws-1", "A"), "ws-2", "B");
    const updated = switchWorkspaceView(state, "ws-1", "kanban");
    expect(getActiveView(updated.workspaces[0])).toBe("kanban");
    expect(getActiveView(updated.workspaces[1])).toBe("terminal");
  });

  it("is a no-op when the workspace id doesn't exist", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const updated = switchWorkspaceView(state, "does-not-exist", "kanban");
    expect(updated).toEqual(state);
  });

  it("remembers the hub tab it was showing when the workspace drops to the terminal", () => {
    const onKanban = switchWorkspaceView(createWorkspace(empty, "ws-1", "A"), "ws-1", "kanban");
    const onTerminal = switchWorkspaceView(onKanban, "ws-1", "terminal");
    expect(getActiveView(onTerminal.workspaces[0])).toBe("terminal");
    expect(onTerminal.workspaces[0].hubView).toBe("kanban");
  });

  it("moves the remembered hub tab along with each hub switch", () => {
    const onKanban = switchWorkspaceView(createWorkspace(empty, "ws-1", "A"), "ws-1", "kanban");
    const onGit = switchWorkspaceView(onKanban, "ws-1", "git");
    expect(onGit.workspaces[0].hubView).toBe("git");
  });
});

describe("removeWorkspace", () => {
  it("removes the workspace and falls back to the first remaining one when it was active", () => {
    const state = createWorkspace(createWorkspace(empty, "ws-1", "A"), "ws-2", "B");
    const removed = removeWorkspace(state, "ws-2");
    expect(removed.workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    expect(removed.activeWorkspaceId).toBe("ws-1");
  });

  it("falls back to null when the last workspace is removed", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const removed = removeWorkspace(state, "ws-1");
    expect(removed.workspaces).toEqual([]);
    expect(removed.activeWorkspaceId).toBeNull();
  });

  it("leaves activeWorkspaceId untouched when removing a non-active workspace", () => {
    const state = createWorkspace(createWorkspace(empty, "ws-1", "A"), "ws-2", "B");
    const switched = switchWorkspace(state, "ws-1", 1000);
    const removed = removeWorkspace(switched, "ws-2");
    expect(removed.activeWorkspaceId).toBe("ws-1");
  });

  it("is a no-op when targeting the pinned Scratchpad workspace", () => {
    const state = createWorkspace(empty, UNFILED_WORKSPACE_ID, "Scratchpad");
    expect(removeWorkspace(state, UNFILED_WORKSPACE_ID)).toEqual(state);
  });
});

describe("createPage", () => {
  it("appends a page to the target workspace and makes it that workspace's active page", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const withPage = createPage(state, "ws-1", "page-1", "Page 1", leaf(["s1"]));
    expect(withPage.workspaces[0].pages).toEqual([
      { id: "page-1", name: "Page 1", layout: leaf(["s1"]), focusedSessionId: null },
    ]);
    expect(withPage.workspaces[0].activePageId).toBe("page-1");
  });
});

describe("renamePage", () => {
  it("updates only the matching page's name", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["s1"]));
    state = createPage(state, "ws-1", "page-2", "Page 2", leaf(["s2"]));
    const renamed = renamePage(state, "ws-1", "page-1", "Renamed");
    expect(renamed.workspaces[0].pages.map((p) => p.name)).toEqual(["Renamed", "Page 2"]);
  });
});

describe("switchPage", () => {
  it("updates only the target workspace's activePageId", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["s1"]));
    state = createPage(state, "ws-1", "page-2", "Page 2", leaf(["s2"]));
    const switched = switchPage(state, "ws-1", "page-1");
    expect(switched.workspaces[0].activePageId).toBe("page-1");
  });
});

describe("removePage", () => {
  it("removes the page and falls back to the first remaining page when it was active", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["s1"]));
    state = createPage(state, "ws-1", "page-2", "Page 2", leaf(["s2"]));
    const removed = removePage(state, "ws-1", "page-2");
    expect(removed.workspaces[0].pages.map((p) => p.id)).toEqual(["page-1"]);
    expect(removed.workspaces[0].activePageId).toBe("page-1");
  });

  it("falls back to null when the workspace's last page is removed, leaving the workspace itself in place", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["s1"]));
    const removed = removePage(state, "ws-1", "page-1");
    expect(removed.workspaces).toEqual([{ id: "ws-1", name: "A", pages: [], activePageId: null }]);
  });
});

describe("updatePageLayout", () => {
  it("replaces only the target page's layout", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["s1"]));
    const updated = updatePageLayout(state, "ws-1", "page-1", leaf(["s1", "s2"]));
    expect(updated.workspaces[0].pages[0].layout).toEqual(leaf(["s1", "s2"]));
  });
});

describe("getActiveWorkspace / getActivePage / getActiveTree", () => {
  it("returns null for all three when there are no workspaces", () => {
    expect(getActiveWorkspace(empty)).toBeNull();
    expect(getActivePage(empty)).toBeNull();
    expect(getActiveTree(empty)).toBeNull();
  });

  it("returns the active workspace, its active page, and that page's tree", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["s1"]));

    expect(getActiveWorkspace(state)?.id).toBe("ws-1");
    expect(getActivePage(state)?.id).toBe("page-1");
    expect(getActiveTree(state)).toEqual(leaf(["s1"]));
  });

  it("returns null for the page/tree when the active workspace has no pages", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    expect(getActivePage(state)).toBeNull();
    expect(getActiveTree(state)).toBeNull();
  });
});

describe("allSessionIdsInWorkspace", () => {
  it("flattens session ids across every page", () => {
    const workspace: Workspace = {
      id: "ws-1",
      name: "A",
      pages: [
        { id: "page-1", name: "Page 1", layout: leaf(["s1", "s2"]), focusedSessionId: null },
        { id: "page-2", name: "Page 2", layout: leaf(["s3"]), focusedSessionId: null },
      ],
      activePageId: "page-1",
    };
    expect(allSessionIdsInWorkspace(workspace)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("findSessionLocation", () => {
  it("finds a session in its own workspace", () => {
    const state: WorkspacesData = {
      workspaces: [{ id: "ws-1", name: "A", pages: [page("page-1", leaf(["s1", "s2"]))], activePageId: "page-1" }],
      activeWorkspaceId: "ws-1",
    };
    expect(findSessionLocation(state, "s2")).toEqual({ workspaceId: "ws-1", pageId: "page-1" });
  });

  it("finds a session after it's moved to a different workspace", () => {
    const state: WorkspacesData = {
      workspaces: [
        { id: "ws-1", name: "A", pages: [page("page-1", leaf(["s1"]))], activePageId: "page-1" },
        { id: "ws-2", name: "B", pages: [page("page-2", leaf(["s2"]))], activePageId: "page-2" },
      ],
      activeWorkspaceId: "ws-1",
    };
    expect(findSessionLocation(state, "s2")).toEqual({ workspaceId: "ws-2", pageId: "page-2" });
  });

  it("returns null for a session that's exited or not present in any page", () => {
    const state: WorkspacesData = {
      workspaces: [{ id: "ws-1", name: "A", pages: [page("page-1", leaf(["s1"]))], activePageId: "page-1" }],
      activeWorkspaceId: "ws-1",
    };
    expect(findSessionLocation(state, "gone")).toBeNull();
  });
});

describe("resolveFocusForPage / setPageFocus / resolveActiveFocus", () => {
  it("resolveFocusForPage prefers the page's own remembered focus when it's still valid", () => {
    const p: Page = { id: "page-1", name: "Page 1", layout: leaf(["a", "b"]), focusedSessionId: "b" };
    expect(resolveFocusForPage(p)).toBe("b");
  });

  it("resolveFocusForPage falls back to the first session when the remembered focus is stale", () => {
    const p: Page = { id: "page-1", name: "Page 1", layout: leaf(["a", "b"]), focusedSessionId: "gone" };
    expect(resolveFocusForPage(p)).toBe("a");
  });

  it("resolveFocusForPage returns null for a null page", () => {
    expect(resolveFocusForPage(null)).toBeNull();
  });

  it("setPageFocus updates only the target page's focusedSessionId", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    const updated = setPageFocus(state, "ws-1", "page-1", "a");
    expect(updated.workspaces[0].pages[0].focusedSessionId).toBe("a");
  });

  it("resolveActiveFocus resolves and stores focus for the active page", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a", "b"]));
    const result = resolveActiveFocus(state);
    expect(result.focusedSessionId).toBe("a");
    expect(result.state.workspaces[0].pages[0].focusedSessionId).toBe("a");
  });

  it("resolveActiveFocus returns null when there is no active page", () => {
    const result = resolveActiveFocus(empty);
    expect(result.focusedSessionId).toBeNull();
    expect(result.state).toEqual(empty);
  });
});

describe("reorderWorkspace", () => {
  it("moves a workspace to a later index", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createWorkspace(state, "ws-3", "C");
    const reordered = reorderWorkspace(state, "ws-1", 2);
    expect(reordered.workspaces.map((w) => w.id)).toEqual(["ws-2", "ws-3", "ws-1"]);
  });

  it("moves a workspace to an earlier index", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createWorkspace(state, "ws-3", "C");
    const reordered = reorderWorkspace(state, "ws-3", 0);
    expect(reordered.workspaces.map((w) => w.id)).toEqual(["ws-3", "ws-1", "ws-2"]);
  });

  it("is a no-op when the workspace id isn't found", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    expect(reorderWorkspace(state, "missing", 0)).toEqual(state);
  });
});

describe("movePage", () => {
  it("reorders a page within its own workspace when source and target workspace match", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    state = createPage(state, "ws-1", "page-2", "Page 2", leaf(["b"]));
    state = createPage(state, "ws-1", "page-3", "Page 3", leaf(["c"]));
    const moved = movePage(state, "page-1", "ws-1", 2);
    expect(moved.workspaces[0].pages.map((p) => p.id)).toEqual(["page-2", "page-3", "page-1"]);
  });

  it("moves a page to a different workspace, inserting at the target index", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    state = createPage(state, "ws-2", "page-2", "Page 2", leaf(["b"]));
    const moved = movePage(state, "page-1", "ws-2", 0);
    expect(moved.workspaces[0].pages.map((p) => p.id)).toEqual([]);
    expect(moved.workspaces[1].pages.map((p) => p.id)).toEqual(["page-1", "page-2"]);
  });

  it("falls back the source workspace's activePageId to a sibling when the moved page was active", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    state = createPage(state, "ws-1", "page-2", "Page 2", leaf(["b"]));
    const moved = movePage(state, "page-2", "ws-2", 0);
    expect(moved.workspaces[0].activePageId).toBe("page-1");
  });

  it("falls back to null when moving a source workspace's only (active) page away", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    const moved = movePage(state, "page-1", "ws-2", 0);
    expect(moved.workspaces[0].activePageId).toBeNull();
  });

  it("is a no-op when the page id isn't found", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    expect(movePage(state, "missing", "ws-2", 0)).toEqual(state);
  });

  it("is a no-op when the target workspace id isn't found", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    expect(movePage(state, "page-1", "missing", 0)).toEqual(state);
  });
});

describe("showsDevOnlyViews", () => {
  it("is true only for the Smoke Test workspace in a dev build", () => {
    expect(showsDevOnlyViews(SMOKETEST_WORKSPACE_ID, true)).toBe(true);
    expect(showsDevOnlyViews(SMOKETEST_WORKSPACE_ID, false)).toBe(false);
    expect(showsDevOnlyViews("ws-1", true)).toBe(false);
    expect(showsDevOnlyViews(UNFILED_WORKSPACE_ID, true)).toBe(false);
  });
});

describe("hubViewIsVisible", () => {
  it("always shows a plain view", () => {
    expect(hubViewIsVisible({}, "ws-1", false, false)).toBe(true);
  });

  it("hides a root-requiring view until a root is bound", () => {
    expect(hubViewIsVisible({ requiresRoot: true }, "ws-1", true, false)).toBe(false);
    expect(hubViewIsVisible({ requiresRoot: true }, "ws-1", true, true)).toBe(true);
  });

  it("keeps the dev-only rule", () => {
    expect(hubViewIsVisible({ devOnly: true }, SMOKETEST_WORKSPACE_ID, true, false)).toBe(true);
    expect(hubViewIsVisible({ devOnly: true }, "ws-1", true, true)).toBe(false);
  });
});

describe("hubLabel", () => {
  it("shows the resolved agent file for the agent-file view", () => {
    expect(hubLabel({ id: "agent-file", label: "CLAUDE.md" }, "AGENTS.md")).toBe("AGENTS.md");
  });

  it("leaves every other view's label alone", () => {
    expect(hubLabel({ id: "kanban", label: "Kanban" }, "AGENTS.md")).toBe("Kanban");
  });
});

describe("workspaceIdForSession", () => {
  const tree = (id: string) => ({ type: "leaf" as const, tabs: [id], activeTabIndex: 0 });

  it("finds a session in a page tree", () => {
    const state = {
      workspaces: [
        { id: "ws-1", name: "A", pages: [{ id: "p1", name: "P", layout: tree("s-1") }], activePageId: "p1" },
      ],
    };
    expect(workspaceIdForSession(state as never, "s-1")).toBe("ws-1");
  });

  it("finds a main agent session, which lives outside every page tree", () => {
    const state = {
      workspaces: [{ id: "ws-1", name: "A", pages: [], activePageId: null, mainSessionId: "agent-1" }],
    };
    expect(workspaceIdForSession(state as never, "agent-1")).toBe("ws-1");
  });

  it("returns null for a session that belongs to no workspace", () => {
    const state = { workspaces: [{ id: "ws-1", name: "A", pages: [], activePageId: null }] };
    expect(workspaceIdForSession(state as never, "nope")).toBeNull();
  });
});

describe("sidebarWorkspaceOrder", () => {
  const w = (id: string): Workspace => ({ id, name: id, pages: [], activePageId: null });

  it("puts Unfiled first and keeps the rest in order", () => {
    const list = [w("a"), w(UNFILED_WORKSPACE_ID), w("b")];
    expect(sidebarWorkspaceOrder(list).map((x) => x.id)).toEqual([UNFILED_WORKSPACE_ID, "a", "b"]);
  });

  it("is a no-op when Unfiled is absent", () => {
    expect(sidebarWorkspaceOrder([w("a"), w("b")]).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("tombstones for removed workspaces", () => {
  const rooted = (id: string, rootPath?: string): Workspace => ({
    id,
    name: id.toUpperCase(),
    pages: [],
    activePageId: null,
    rootPath,
  });

  const state = (workspaces: Workspace[], removed?: WorkspacesData["removedWorkspaces"]): WorkspacesData => ({
    workspaces,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    removedWorkspaces: removed,
  });

  describe("rememberRemoved", () => {
    it("records the id, name, root and time of a rooted workspace", () => {
      const next = rememberRemoved(state([rooted("a", "/repo/a")]), "a", 1000);
      expect(next.removedWorkspaces).toEqual([
        { id: "a", name: "A", rootPath: "/repo/a", removedAt: 1000 },
      ]);
    });

    // A workspace that was never bound owns no files and can never be
    // matched by a later folder pick, so a record for it is noise.
    it("writes nothing for a workspace with no root", () => {
      const next = rememberRemoved(state([rooted("a")]), "a", 1000);
      expect(next.removedWorkspaces).toBeUndefined();
    });

    it("writes nothing for a root that is only whitespace", () => {
      const next = rememberRemoved(state([rooted("a", "   ")]), "a", 1000);
      expect(next.removedWorkspaces).toBeUndefined();
    });

    it("writes nothing for an unknown workspace", () => {
      const next = rememberRemoved(state([rooted("a", "/repo/a")]), "nope", 1000);
      expect(next.removedWorkspaces).toBeUndefined();
    });

    it("puts the newest record first", () => {
      const first = rememberRemoved(state([rooted("a", "/repo/a"), rooted("b", "/repo/b")]), "a", 1000);
      const second = rememberRemoved({ ...first, workspaces: [rooted("b", "/repo/b")] }, "b", 2000);
      expect(second.removedWorkspaces?.map((t) => t.id)).toEqual(["b", "a"]);
    });

    // Two records for one folder would make "the newest match" a
    // question about list order rather than about time.
    it("replaces an earlier record for the same root", () => {
      const first = rememberRemoved(state([rooted("a", "/repo/x")]), "a", 1000);
      const second = rememberRemoved({ ...first, workspaces: [rooted("b", "/repo/x/")] }, "b", 2000);
      expect(second.removedWorkspaces).toEqual([
        { id: "b", name: "B", rootPath: "/repo/x/", removedAt: 2000 },
      ]);
    });

    it("caps the list, dropping the oldest", () => {
      let s: WorkspacesData = state([]);
      for (let i = 0; i < REMOVED_WORKSPACES_LIMIT + 5; i++) {
        s = rememberRemoved({ ...s, workspaces: [rooted(`w${i}`, `/repo/${i}`)] }, `w${i}`, i);
      }
      expect(s.removedWorkspaces).toHaveLength(REMOVED_WORKSPACES_LIMIT);
      expect(s.removedWorkspaces?.[0].id).toBe(`w${REMOVED_WORKSPACES_LIMIT + 4}`);
      expect(s.removedWorkspaces?.some((t) => t.id === "w0")).toBe(false);
    });
  });

  describe("matchTombstone", () => {
    const removed = [
      { id: "old", name: "Old", rootPath: "/repo/x", removedAt: 1000 },
      { id: "new", name: "New", rootPath: "/repo/x", removedAt: 3000 },
      { id: "other", name: "Other", rootPath: "/repo/y", removedAt: 2000 },
    ];

    it("returns the newest record for the root", () => {
      expect(matchTombstone(state([], removed), "/repo/x")?.id).toBe("new");
    });

    it("ignores a trailing separator on either side", () => {
      expect(matchTombstone(state([], removed), "/repo/x/")?.id).toBe("new");
      expect(matchTombstone(state([], [{ ...removed[2], rootPath: "/repo/y/" }]), "/repo/y")?.id).toBe(
        "other"
      );
    });

    it("returns null for a root nothing was removed from", () => {
      expect(matchTombstone(state([], removed), "/repo/z")).toBeNull();
    });

    it("returns null when there are no records at all", () => {
      expect(matchTombstone(state([]), "/repo/x")).toBeNull();
    });

    // Restoring onto an id a live workspace already holds would put two
    // workspaces in the app under one id.
    it("skips a record whose id is already in use", () => {
      const live = state([rooted("new", "/somewhere/else")], removed);
      expect(matchTombstone(live, "/repo/x")?.id).toBe("old");
    });
  });

  describe("forgetTombstone", () => {
    it("drops the named record and keeps the rest", () => {
      const removed = [
        { id: "a", name: "A", rootPath: "/repo/a", removedAt: 1 },
        { id: "b", name: "B", rootPath: "/repo/b", removedAt: 2 },
      ];
      expect(forgetTombstone(state([], removed), "a").removedWorkspaces?.map((t) => t.id)).toEqual(["b"]);
    });

    it("is a no-op for an id that is not recorded", () => {
      expect(forgetTombstone(state([]), "a").removedWorkspaces).toEqual([]);
    });
  });

  // The list is a carry-through field: any function that rebuilds the
  // record from a fresh literal instead of spreading would silently wipe
  // every record it holds.
  describe("the record survives the functions that rebuild it", () => {
    const removed = [{ id: "a", name: "A", rootPath: "/repo/a", removedAt: 1 }];

    it("survives removeWorkspace", () => {
      const s = state([rooted("x", "/repo/x")], removed);
      expect(removeWorkspace(s, "x").removedWorkspaces).toEqual(removed);
    });

    it("survives createWorkspace", () => {
      expect(createWorkspace(state([], removed), "n", "N").removedWorkspaces).toEqual(removed);
    });
  });
});

describe("reclaimable", () => {
  const tombstone = { id: "old", name: "Old", rootPath: "/repo/x", removedAt: 1 };
  const state = (w: Workspace): WorkspacesData => ({
    workspaces: [w],
    activeWorkspaceId: w.id,
    removedWorkspaces: [tombstone],
  });
  const empty = (over: Partial<Workspace> = {}): Workspace => ({
    id: "fresh",
    name: "Fresh",
    pages: [],
    activePageId: null,
    ...over,
  });

  it("offers the record for an empty workspace bound to the removed root", () => {
    expect(reclaimable(state(empty()), "fresh", "/repo/x")).toEqual(tombstone);
  });

  it("offers nothing for a different root", () => {
    expect(reclaimable(state(empty()), "fresh", "/repo/y")).toBeNull();
  });

  // Out of scope by design: re-pointing a live workspace would have to
  // migrate its tabs, board tabs and watch, not just swap an id.
  it("offers nothing for a workspace already bound to a root", () => {
    expect(reclaimable(state(empty({ rootPath: "/somewhere" })), "fresh", "/repo/x")).toBeNull();
  });

  it("offers nothing for a workspace that holds sessions", () => {
    const withPage = empty({
      pages: [{ id: "p1", name: "P", layout: leaf(["s-1"]), focusedSessionId: null }],
      activePageId: "p1",
    });
    expect(reclaimable(state(withPage), "fresh", "/repo/x")).toBeNull();
  });

  it("offers nothing for a workspace running a main agent", () => {
    expect(reclaimable(state(empty({ mainSessionId: "agent-1" })), "fresh", "/repo/x")).toBeNull();
  });

  it("offers nothing for an unknown workspace", () => {
    expect(reclaimable(state(empty()), "nope", "/repo/x")).toBeNull();
  });
});

describe("restoreWorkspaceId", () => {
  const tombstone = { id: "old", name: "Old", rootPath: "/repo/x", removedAt: 1 };
  const base: WorkspacesData = {
    workspaces: [
      {
        id: "fresh",
        name: "Fresh",
        pages: [{ id: "p1", name: "P", layout: leaf([]), focusedSessionId: null }],
        activePageId: "p1",
        color: "#abcdef",
      },
      { id: "other", name: "Other", pages: [], activePageId: null },
    ],
    activeWorkspaceId: "fresh",
    removedWorkspaces: [tombstone],
  };

  it("swaps the id, binds the root and carries the workspace over whole", () => {
    const next = restoreWorkspaceId(base, "fresh", "old", "/repo/x");
    expect(next.workspaces.map((w) => w.id)).toEqual(["old", "other"]);
    expect(next.workspaces[0]).toMatchObject({
      name: "Fresh",
      rootPath: "/repo/x",
      color: "#abcdef",
      activePageId: "p1",
    });
    expect(next.workspaces[0].pages.map((p) => p.id)).toEqual(["p1"]);
  });

  it("re-points the active id when it was the restored workspace", () => {
    expect(restoreWorkspaceId(base, "fresh", "old", "/repo/x").activeWorkspaceId).toBe("old");
  });

  it("leaves the active id alone when it was some other workspace", () => {
    const elsewhere = { ...base, activeWorkspaceId: "other" };
    expect(restoreWorkspaceId(elsewhere, "fresh", "old", "/repo/x").activeWorkspaceId).toBe("other");
  });

  it("spends the record", () => {
    expect(restoreWorkspaceId(base, "fresh", "old", "/repo/x").removedWorkspaces).toEqual([]);
  });
});
