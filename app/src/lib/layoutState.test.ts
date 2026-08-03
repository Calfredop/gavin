import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import type { LayoutNode } from "./layout";
import type { Page, Workspace } from "./workspace";

vi.mock("./backend", () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
  getWorkspacesState: vi.fn(),
  setWorkspacesState: vi.fn(),
  getBootstrapError: vi.fn(),
  writeInput: vi.fn(),
  setOnWriteInputHook: vi.fn(),
  resizeSession: vi.fn(),
  signalFrontendReady: vi.fn(),
  getSessionNames: vi.fn(),
  setSessionName: vi.fn(),
}));

vi.mock("./terminalRegistry", () => ({
  destroyTerminal: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("./notifications", () => ({
  maybeNotifyStatusChange: vi.fn(),
}));

import * as backend from "./backend";
import * as notifications from "./notifications";
import {
  layoutState,
  splitPane,
  addTab,
  closeSession,
  switchToTab,
  switchToSessionInPage,
  focusPane,
  handleSessionExited,
  handleCwdChanged,
  handleSessionStatusChanged,
  handleGitStatusChanged,
  handleSessionRestored,
  clearRestoredMarker,
  closePane,
  setSessionName,
  createWorkspace,
  renameWorkspace,
  switchWorkspace,
  closeWorkspace,
  createPage,
  renamePage,
  switchPage,
  closePage,
  movePaneOrTab,
  reorderTabWithinPane,
  reorderWorkspaceAction,
  movePageAction,
  bootstrap,
  teardown,
} from "./layoutState";

function leaf(tabs: string[], activeTabIndex = 0): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex };
}

function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

function ws(id: string, pages: Page[], activePageId: string | null = pages[0]?.id ?? null): Workspace {
  return { id, name: id, pages, activePageId };
}

function setState(workspaces: Workspace[], activeWorkspaceId: string | null, focusedSessionId: string | null): void {
  layoutState.set({
    status: "ready",
    errorMessage: "",
    workspaces,
    activeWorkspaceId,
    focusedSessionId,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
    gitStatusById: {},
    restoredSessionIds: new Set(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutState.set({
    status: "connecting",
    errorMessage: "",
    workspaces: [],
    activeWorkspaceId: null,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
    gitStatusById: {},
    restoredSessionIds: new Set(),
  });
});

describe("splitPane", () => {
  it("creates a session, splits the active page's tree, and persists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await splitPane("a", "row");

    expect(backend.createSession).toHaveBeenCalledOnce();
    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["a"]), leaf(["b"])],
    });
    expect(state.focusedSessionId).toBe("b");
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-1");
  });

  it("is a no-op when there is no active page", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    await splitPane("a", "row");

    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("leaves the tree unchanged and surfaces an error when create_session fails", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.createSession).mockRejectedValue(new Error("daemon unreachable"));

    await splitPane("a", "row");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
    expect(state.status).toBe("error");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });
});

describe("addTab", () => {
  it("creates a session, appends it as a new active tab in the active page, and persists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await addTab("a");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a", "b"], 1));
    expect(state.focusedSessionId).toBe("b");
  });
});

describe("closeSession", () => {
  it("kills the session then removes it from its page", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "b");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("b");

    expect(backend.killSession).toHaveBeenCalledWith("b");
    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
  });

  it("does not remove the session when the daemon kill fails", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "b");
    vi.mocked(backend.killSession).mockRejectedValue(new Error("no such session"));

    await closeSession("b");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a", "b"]));
    expect(state.status).toBe("error");
  });

  it("removes the whole page when closing its last session, keeping the workspace", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("a");

    const state = get(layoutState);
    expect(state.workspaces).toEqual([ws("ws-1", [], null)]);
  });
});

describe("handleSessionExited", () => {
  it("finds and removes a session in a non-active page", () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b", "c"]))], "page-1")],
      "ws-1",
      "a"
    );

    handleSessionExited("c");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[1].layout).toEqual(leaf(["b"]));
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  it("reassigns focus to the active page's first session when the focused session exits", () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "a");

    handleSessionExited("a");

    expect(get(layoutState).focusedSessionId).toBe("b");
  });

  it("leaves focus untouched when a background (non-focused) session exits", () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "b");

    handleSessionExited("a");

    expect(get(layoutState).focusedSessionId).toBe("b");
  });

  it("is a no-op for a session id absent from every page of every workspace", () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    expect(() => handleSessionExited("already-gone")).not.toThrow();

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });
});

describe("handleCwdChanged", () => {
  it("records the cwd for a session", () => {
    setState([], null, null);
    handleCwdChanged("a", "/Users/alice/project");
    expect(get(layoutState).cwdBySessionId).toEqual({ a: "/Users/alice/project" });
  });

  it("updates an existing session's cwd without disturbing others", () => {
    layoutState.update((s) => ({ ...s, cwdBySessionId: { a: "/old/path", b: "/other/path" } }));
    handleCwdChanged("a", "/new/path");
    expect(get(layoutState).cwdBySessionId).toEqual({ a: "/new/path", b: "/other/path" });
  });
});

describe("handleSessionStatusChanged", () => {
  it("stores the new status under the session's id", () => {
    handleSessionStatusChanged("a", "working");
    expect(get(layoutState).sessionStatusById["a"]).toBe("working");
  });

  it("overwrites a previous status for the same session", () => {
    handleSessionStatusChanged("a", "working");
    handleSessionStatusChanged("a", "idle");
    expect(get(layoutState).sessionStatusById["a"]).toBe("idle");
  });

  it("leaves other sessions' statuses untouched", () => {
    handleSessionStatusChanged("a", "working");
    handleSessionStatusChanged("b", "waiting_for_input");
    expect(get(layoutState).sessionStatusById).toEqual({ a: "working", b: "waiting_for_input" });
  });

  it("hands the previous and new status to maybeNotifyStatusChange, before overwriting the map", () => {
    handleSessionStatusChanged("a", "working");
    handleSessionStatusChanged("a", "idle");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(1, "a", undefined, "working", "a");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(2, "a", "working", "idle", "a");
  });

  it("resolves the notification label via sessionNames, falling back the same way tab labels do", () => {
    setState([], null, null);
    layoutState.update((s) => ({ ...s, sessionNames: { a: "my-session" } }));
    handleSessionStatusChanged("a", "waiting_for_input");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenCalledWith("a", undefined, "waiting_for_input", "my-session");
  });
});

describe("handleGitStatusChanged", () => {
  it("sets a session's git status", () => {
    const status = { repoRoot: "/repo", branch: "main", dirty: true, ahead: 0, behind: 0, hasUpstream: false };
    handleGitStatusChanged("a", status);
    expect(get(layoutState).gitStatusById["a"]).toEqual(status);
  });

  it("overwrites a session's previous git status", () => {
    const dirty = { repoRoot: "/repo", branch: "main", dirty: true, ahead: 0, behind: 0, hasUpstream: false };
    const clean = { ...dirty, dirty: false };
    handleGitStatusChanged("a", dirty);
    handleGitStatusChanged("a", clean);
    expect(get(layoutState).gitStatusById["a"]).toEqual(clean);
  });

  it("can be set to null (the session left its repo, or never had one)", () => {
    const status = { repoRoot: "/repo", branch: "main", dirty: true, ahead: 0, behind: 0, hasUpstream: false };
    handleGitStatusChanged("a", status);
    handleGitStatusChanged("a", null);
    expect(get(layoutState).gitStatusById["a"]).toBeNull();
  });

  it("tracks independent sessions independently", () => {
    const statusA = { repoRoot: "/repo-a", branch: "main", dirty: false, ahead: 0, behind: 0, hasUpstream: false };
    const statusB = { repoRoot: "/repo-b", branch: "dev", dirty: true, ahead: 1, behind: 0, hasUpstream: true };
    handleGitStatusChanged("a", statusA);
    handleGitStatusChanged("b", statusB);
    expect(get(layoutState).gitStatusById).toEqual({ a: statusA, b: statusB });
  });
});

describe("handleSessionRestored and clearRestoredMarker", () => {
  it("adds a session id when restored", () => {
    handleSessionRestored("a");
    expect(get(layoutState).restoredSessionIds.has("a")).toBe(true);
  });

  it("tracks independent sessions independently", () => {
    handleSessionRestored("a");
    handleSessionRestored("b");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set(["a", "b"]));
  });

  it("adding the same id twice is idempotent", () => {
    handleSessionRestored("a");
    handleSessionRestored("a");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set(["a"]));
  });

  it("clearRestoredMarker removes just that session's id", () => {
    handleSessionRestored("a");
    handleSessionRestored("b");
    clearRestoredMarker("a");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set(["b"]));
  });

  it("clearRestoredMarker on a session that was never restored is a harmless no-op", () => {
    clearRestoredMarker("never-restored");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set());
  });
});

describe("closePane", () => {
  it("closes every tab in the pane, killing each session, and always persists", async () => {
    setState(
      [
        ws("ws-1", [
          page(
            "page-1",
            {
              type: "split",
              direction: "row",
              sizes: [0.5, 0.5],
              children: [leaf(["a", "b"], 1), leaf(["c"])],
            }
          ),
        ]),
      ],
      "ws-1",
      "b"
    );
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePane("b");

    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.killSession).toHaveBeenCalledWith("b");
    expect(backend.killSession).not.toHaveBeenCalledWith("c");
    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["c"]));
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-1");
  });

  it("removes the page (not just clears it) when closing its only pane, and still persists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePane("a");

    const state = get(layoutState);
    expect(state.workspaces).toEqual([ws("ws-1", [], null)]);
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-1");
  });

  it("does not throw and does not mutate state when the session id isn't found", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await expect(closePane("missing")).resolves.toBeUndefined();

    expect(backend.killSession).not.toHaveBeenCalled();
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });
});

describe("switchToTab", () => {
  it("updates activeTabIndex within the active page and persists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "a");

    await switchToTab("b");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a", "b"], 1));
    expect(state.focusedSessionId).toBe("b");
  });
});

describe("switchToSessionInPage", () => {
  it("switches workspace and page, and makes the target session the active tab and focus", async () => {
    const treeA = leaf(["a1", "a2"]);
    const treeB = leaf(["b1"]);
    setState(
      [ws("ws-1", [page("page-a", treeA), page("page-b", treeB)], "page-a")],
      "ws-1",
      "a1"
    );
    await switchToSessionInPage("ws-1", "page-a", "a2");
    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-1");
    expect(state.focusedSessionId).toBe("a2");
    const pageA = state.workspaces[0].pages.find((p) => p.id === "page-a");
    expect(pageA?.layout).toEqual(leaf(["a1", "a2"], 1));
    expect(pageA?.focusedSessionId).toBe("a2");
  });

  it("switches to a different page's own tab when the target session lives there", async () => {
    const treeA = leaf(["a1"]);
    const treeB = leaf(["b1", "b2"]);
    setState(
      [ws("ws-1", [page("page-a", treeA), page("page-b", treeB)], "page-a")],
      "ws-1",
      "a1"
    );
    await switchToSessionInPage("ws-1", "page-b", "b2");
    const state = get(layoutState);
    const wsAfter = state.workspaces[0];
    expect(wsAfter.activePageId).toBe("page-b");
    expect(state.focusedSessionId).toBe("b2");
  });

  it("switches workspace when the target session lives in a different, inactive workspace", async () => {
    setState(
      [
        ws("ws-1", [page("page-a", leaf(["a1"]))], "page-a"),
        ws("ws-2", [page("page-b", leaf(["b1", "b2"]))], "page-b"),
      ],
      "ws-1",
      "a1"
    );
    await switchToSessionInPage("ws-2", "page-b", "b2");
    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-2");
    expect(state.focusedSessionId).toBe("b2");
  });

  it("does nothing when the page doesn't exist", async () => {
    setState([ws("ws-1", [page("page-a", leaf(["a1"]))])], "ws-1", "a1");
    await switchToSessionInPage("ws-1", "no-such-page", "a1");
    expect(get(layoutState).focusedSessionId).toBe("a1");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  it("persists the updated workspaces state", async () => {
    setState([ws("ws-1", [page("page-a", leaf(["a1", "a2"]))])], "ws-1", "a1");
    await switchToSessionInPage("ws-1", "page-a", "a2");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });
});

describe("focusPane", () => {
  it("updates focus without touching workspaces or persisting", () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", null);

    focusPane("a");

    expect(get(layoutState).focusedSessionId).toBe("a");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });
});

describe("setSessionName", () => {
  it("records a trimmed name and persists it", async () => {
    vi.mocked(backend.setSessionName).mockResolvedValue(undefined);
    await setSessionName("a", "  my project  ");
    expect(get(layoutState).sessionNames).toEqual({ a: "my project" });
    expect(backend.setSessionName).toHaveBeenCalledWith("a", "my project");
  });

  it("clears the name when given a blank string", async () => {
    layoutState.update((s) => ({ ...s, sessionNames: { a: "old name" } }));
    vi.mocked(backend.setSessionName).mockResolvedValue(undefined);
    await setSessionName("a", "   ");
    expect(get(layoutState).sessionNames).toEqual({});
  });
});

describe("createWorkspace", () => {
  it("appends a new workspace, makes it active, and clears focus since the new workspace has no pages yet", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await createWorkspace("My Project");

    const state = get(layoutState);
    expect(state.workspaces).toHaveLength(2);
    expect(state.workspaces[1].name).toBe("My Project");
    expect(state.activeWorkspaceId).toBe(state.workspaces[1].id);
    expect(state.focusedSessionId).toBeNull();
  });
});

describe("renameWorkspace", () => {
  it("updates only the target workspace's name", async () => {
    setState([ws("ws-1", []), ws("ws-2", [])], "ws-1", null);

    await renameWorkspace("ws-1", "Renamed");

    expect(get(layoutState).workspaces.map((w) => w.name)).toEqual(["Renamed", "ws-2"]);
  });
});

describe("switchWorkspace", () => {
  it("updates activeWorkspaceId and recomputes focusedSessionId", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"]))]), ws("ws-2", [page("page-2", leaf(["x"]))])],
      "ws-1",
      "a"
    );

    await switchWorkspace("ws-2");

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-2");
    expect(state.focusedSessionId).toBe("x");
  });

  it("sets focusedSessionId to null when switching to an empty workspace", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))]), ws("ws-2", [])], "ws-1", "a");

    await switchWorkspace("ws-2");

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-2");
    expect(state.focusedSessionId).toBe(null);
  });
});

describe("closeWorkspace", () => {
  it("kills every session across every page, then removes the workspace", async () => {
    setState(
      [
        ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))]),
        ws("ws-2", [page("page-3", leaf(["d"]))]),
      ],
      "ws-1",
      "a"
    );
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeWorkspace("ws-1");

    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.killSession).toHaveBeenCalledWith("b");
    expect(backend.killSession).toHaveBeenCalledWith("c");
    expect(backend.killSession).not.toHaveBeenCalledWith("d");
    const state = get(layoutState);
    expect(state.workspaces.map((w) => w.id)).toEqual(["ws-2"]);
    expect(state.activeWorkspaceId).toBe("ws-2");
  });
});

describe("createPage", () => {
  it("creates N sessions, builds the tree, appends the page to the given workspace, and makes it active", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValueOnce("a").mockResolvedValueOnce("b");

    await createPage("ws-1", ([x, y]) => ({ type: "split", direction: "row", children: [leaf([x]), leaf([y])], sizes: [0.5, 0.5] }), 2, "Page 1");

    const state = get(layoutState);
    expect(state.workspaces[0].pages).toHaveLength(1);
    expect(state.workspaces[0].pages[0].name).toBe("Page 1");
    expect(state.workspaces[0].activePageId).toBe(state.workspaces[0].pages[0].id);
    expect(state.activeWorkspaceId).toBe("ws-1");
    expect(state.focusedSessionId).toBe("a");
  });

  it("is a no-op for an unknown workspace id", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    await createPage("missing", ([x]) => leaf([x]), 1, "Page 1");

    expect(backend.createSession).not.toHaveBeenCalled();
  });
});

describe("renamePage", () => {
  it("updates only the target page's name", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))])], "ws-1", null);

    await renamePage("ws-1", "page-1", "Renamed");

    expect(get(layoutState).workspaces[0].pages.map((p) => p.name)).toEqual(["Renamed", "page-2"]);
  });
});

describe("switchPage", () => {
  it("updates the target workspace's activePageId and recomputes focusedSessionId", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))], "page-1")],
      "ws-1",
      "a"
    );

    await switchPage("ws-1", "page-2");

    const state = get(layoutState);
    expect(state.workspaces[0].activePageId).toBe("page-2");
    expect(state.focusedSessionId).toBe("b");
  });

  it("also activates the target workspace when switching to a page in a different one", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"]))]), ws("ws-2", [page("page-2", leaf(["b"]))])],
      "ws-1",
      "a"
    );

    await switchPage("ws-2", "page-2");

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-2");
    expect(state.focusedSessionId).toBe("b");
  });
});

describe("closePage", () => {
  it("kills every session in the page, then removes it", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))], "page-1")],
      "ws-1",
      "a"
    );
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePage("ws-1", "page-1");

    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.killSession).toHaveBeenCalledWith("b");
    expect(backend.killSession).not.toHaveBeenCalledWith("c");
    const state = get(layoutState);
    expect(state.workspaces[0].pages.map((p) => p.id)).toEqual(["page-2"]);
  });
});

describe("movePaneOrTab", () => {
  it("moves a whole pane (all its tabs together) to a different page, grafting right", async () => {
    // page-1 has TWO panes: a 2-tab leaf ["a","b"] and a separate 1-tab
    // leaf ["z"]. Dragging the pane anchored at "a" must detach the
    // WHOLE leaf it belongs to -- both "a" and "b" together -- not just
    // "a" alone, since detachLeaf detaches the entire pane a session id
    // is found in.
    setState(
      [
        ws(
          "ws-1",
          [
            page("page-1", {
              type: "split",
              direction: "row",
              sizes: [0.5, 0.5],
              children: [leaf(["a", "b"]), leaf(["z"])],
            }),
            page("page-2", leaf(["c"])),
          ],
          "page-1"
        ),
      ],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-2", mode: "right" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["z"]));
    expect(state.workspaces[0].pages[1].layout).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["c"]), leaf(["a", "b"])],
    });
  });

  it("removes the source page entirely when detaching its only pane", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))], "page-1")],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-2", mode: "left" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages.map((p) => p.id)).toEqual(["page-2"]);
  });

  it("moves a single tab, merging it as a new tab via mode center", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))], "page-1")],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "tab", workspaceId: "ws-1", pageId: "page-1", sessionId: "b" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-2", mode: "center" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
    expect(state.workspaces[0].pages[1].layout).toEqual(leaf(["c", "b"], 1));
  });

  it("creates a new page when the drop target is a workspace, not a specific page", async () => {
    // Same reasoning as the previous test: page-1 needs two SEPARATE
    // panes for detaching one of them to leave the page non-empty and to
    // correctly carry both of the detached pane's tabs together.
    setState(
      [
        ws("ws-1", [
          page("page-1", {
            type: "split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [leaf(["a", "b"]), leaf(["z"])],
          }),
        ]),
        ws("ws-2", []),
      ],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "workspace", workspaceId: "ws-2" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["z"]));
    expect(state.workspaces[1].pages).toHaveLength(1);
    expect(state.workspaces[1].pages[0].layout).toEqual(leaf(["a", "b"]));
  });

  it("is a no-op when the whole page's only pane is dropped back onto that same, now-empty page", async () => {
    // page-1's tree is a single leaf holding both "a" and "b" -- one
    // pane, two tabs -- so dragging that whole pane detaches the page's
    // entire tree, removing the page. There's no page left to graft back
    // into, so this resolves via the natural "target page not found"
    // fallback, not an explicit same-page guard (see movePaneOrTab's own
    // comment on why there isn't one).
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "a");

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-1", mode: "right" }
    );

    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual(leaf(["a", "b"]));
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  it("rearranges panes within the same page when the page has more than one pane", async () => {
    // page-1 has TWO panes (two separate leaves, "a" and "b"), unlike the
    // single-pane-two-tabs case above -- dragging pane "a" onto the same
    // page is a genuine rearrangement here (detach "a", the page still
    // has "b" left, graft "a" back in next to it), not a no-op.
    setState(
      [
        ws(
          "ws-1",
          [
            page("page-1", {
              type: "split",
              direction: "row",
              sizes: [0.5, 0.5],
              children: [leaf(["a"]), leaf(["b"])],
            }),
          ]
        ),
      ],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-1", mode: "bottom" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [leaf(["b"]), leaf(["a"])],
    });
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("merges into the specifically targeted pane when targetSessionId is given, not just the page's remembered focus", async () => {
    // page-1 has two panes: leaf(["a1","a2"]) and leaf(["b1"]). The
    // page's own remembered focusedSessionId is null (page()'s default),
    // so without the fix this would fall back to the tree's first
    // session ("a1") -- the fix under test is that explicitly targeting
    // "b1" lands the merge there instead.
    setState(
      [
        ws("ws-1", [
          page("page-1", {
            type: "split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [leaf(["a1", "a2"]), leaf(["b1"])],
          }),
        ]),
      ],
      "ws-1",
      "a1"
    );

    await movePaneOrTab(
      { kind: "tab", workspaceId: "ws-1", pageId: "page-1", sessionId: "a2" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-1", mode: "center", targetSessionId: "b1" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["a1"]), leaf(["b1", "a2"], 1)],
    });
  });

  it("grafts at the specific pane via targetSessionId on a 3+-pane page, not the whole page", async () => {
    // A 2x2 grid: dragging pane "c" onto pane "d"'s right edge should
    // split just d's location, not wrap the entire grid.
    setState(
      [
        ws("ws-1", [
          page("page-1", {
            type: "split",
            direction: "column",
            sizes: [0.5, 0.5],
            children: [
              { type: "split", direction: "row", sizes: [0.5, 0.5], children: [leaf(["a"]), leaf(["b"])] },
              { type: "split", direction: "row", sizes: [0.5, 0.5], children: [leaf(["c"]), leaf(["d"])] },
            ],
          }),
        ]),
      ],
      "ws-1",
      "c"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "c" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-1", mode: "right", targetSessionId: "d" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [
        { type: "split", direction: "row", sizes: [0.5, 0.5], children: [leaf(["a"]), leaf(["b"])] },
        { type: "split", direction: "row", sizes: [0.5, 0.5], children: [leaf(["d"]), leaf(["c"])] },
      ],
    });
  });
});

describe("reorderTabWithinPane", () => {
  it("reorders a tab within the active page's pane and persists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b", "c"], 0))])], "ws-1", "a");

    await reorderTabWithinPane("a", 2);

    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual(leaf(["b", "c", "a"], 2));
  });
});

describe("reorderWorkspaceAction", () => {
  it("reorders workspaces and persists", async () => {
    setState([ws("ws-1", []), ws("ws-2", []), ws("ws-3", [])], "ws-1", null);

    await reorderWorkspaceAction("ws-3", 0);

    expect(get(layoutState).workspaces.map((w) => w.id)).toEqual(["ws-3", "ws-1", "ws-2"]);
  });
});

describe("movePageAction", () => {
  it("moves a non-active page without changing activeWorkspaceId", async () => {
    setState(
      [
        ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))], "page-1"),
        ws("ws-2", []),
      ],
      "ws-1",
      "a"
    );

    await movePageAction("page-2", "ws-2", 0);

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-1");
    expect(state.workspaces[1].pages.map((p) => p.id)).toEqual(["page-2"]);
  });

  it("follows the moved page when it was the active one", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"]))], "page-1"), ws("ws-2", [])],
      "ws-1",
      "a"
    );

    await movePageAction("page-1", "ws-2", 0);

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-2");
    expect(state.workspaces[1].activePageId).toBe("page-1");
    expect(state.focusedSessionId).toBe("a");
  });
});

describe("bootstrap / pollForStartupState readiness", () => {
  afterEach(() => {
    teardown();
  });

  it("treats an empty WorkspacesData as ready on the first poll attempt, not still-connecting", async () => {
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});

    await bootstrap();
    // bootstrap() resolves once listeners are registered; give the
    // fire-and-forget pollForStartupState's first iteration a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = get(layoutState);
    expect(state.status).toBe("ready");
    expect(state.workspaces).toEqual([]);
  });

  it("keeps polling (stays connecting) while the invoke rejects, then becomes ready once it resolves", async () => {
    vi.mocked(backend.getWorkspacesState)
      .mockRejectedValueOnce(new Error("not managed yet"))
      .mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});

    await bootstrap();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(get(layoutState).status).toBe("connecting");

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(get(layoutState).status).toBe("ready");
  });
});
