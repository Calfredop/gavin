import { describe, it, expect, vi, beforeEach } from "vitest";
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
  resizeSession: vi.fn(),
  signalFrontendReady: vi.fn(),
  getSessionNames: vi.fn(),
  setSessionName: vi.fn(),
}));

vi.mock("./terminalRegistry", () => ({
  destroyTerminal: vi.fn(),
}));

import * as backend from "./backend";
import {
  layoutState,
  splitPane,
  addTab,
  closeSession,
  switchToTab,
  focusPane,
  handleSessionExited,
  handleCwdChanged,
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
  it("appends a new workspace, makes it active, and persists", async () => {
    setState([], null, null);

    await createWorkspace("My Project");

    const state = get(layoutState);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].name).toBe("My Project");
    expect(state.activeWorkspaceId).toBe(state.workspaces[0].id);
    expect(state.focusedSessionId).toBe(null);
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, state.workspaces[0].id);
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
