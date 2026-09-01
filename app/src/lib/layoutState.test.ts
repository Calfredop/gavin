import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { gavinTrees } from "./gavinState";
import type { LayoutNode } from "./layout";
import { allSessionIds } from "./layout";
import type { Page, Workspace } from "./workspace";
import { getActiveView } from "./workspace";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { kanbanState } from "./kanbanState";
import { orchestrations } from "./orchestrationState";
import { toolRecords } from "./toolsState";

// setWorkspaceRoot's reclaim offer is the only dialog this module opens.
// Defaults to "Start fresh" so every test that is not about the reclaim
// takes the ordinary binding path.
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn().mockResolvedValue(false) }));

vi.mock("./backend", () => ({
  createSession: vi.fn(),
  // Resolved by default: handleAgentSessionSpawned calls .catch() on this.
  killSession: vi.fn().mockResolvedValue(undefined),
  getWorkspacesState: vi.fn(),
  setWorkspacesState: vi.fn(),
  getBootstrapError: vi.fn(),
  restartDaemon: vi.fn(),
  // Resolved by default: every path that re-syncs against a (re)connected
  // daemon refreshes the compat verdict, and restartDaemonInPlace now
  // awaits it to report what the restart landed on.
  daemonCompat: vi.fn().mockResolvedValue(null),
  writeInput: vi.fn(),
  setOnWriteInputHook: vi.fn(),
  resizeSession: vi.fn(),
  signalFrontendReady: vi.fn(),
  getSessionNames: vi.fn(),
  setSessionName: vi.fn(),
  deleteBoard: vi.fn(),
  // Resolved by default, like getBoardTabs below: loadTabMaps awaits both
  // before startup may leave "connecting", so a mock returning undefined
  // would wedge every bootstrap test that isn't specifically about file
  // tabs.
  getFileTabs: vi.fn().mockResolvedValue({}),
  // Resolved by default: pruneFileTabs calls .catch() on this, so a bare
  // vi.fn() returning undefined would throw instead of exercising the
  // real best-effort path.
  setFileTabs: vi.fn().mockResolvedValue(undefined),
  setRootConfigField: vi.fn().mockResolvedValue(undefined),
  composeAgentPrompt: vi.fn().mockResolvedValue("prompt"),
  agentProfiles: vi.fn().mockResolvedValue([]),
  getAgentModelDefaults: vi.fn().mockResolvedValue({}),
  mcpFormats: vi.fn().mockResolvedValue([]),
  moveAgentFile: vi.fn().mockResolvedValue(undefined),
  // Resolved by default: endTabs calls .catch() on this, so a bare
  // vi.fn() returning undefined would throw rather than exercise the
  // real best-effort path.
  unwatchFileForViewer: vi.fn().mockResolvedValue(undefined),
  // Resolved by default: setWorkspaceRoot and watchRootedWorkspaces call
  // .catch() on these.
  watchGavinRoot: vi.fn().mockResolvedValue(undefined),
  unwatchGavinRoot: vi.fn().mockResolvedValue(undefined),
  getBoardTabs: vi.fn().mockResolvedValue({}),
  // Resolved by default: bootstrap calls this best-effort to refill the
  // maps a frontend reload starts blank on.
  getSessionBaselines: vi.fn().mockResolvedValue([]),
  // Same: the git half of that refill, keyed by the cwds the call above
  // returned.
  getGitBaselines: vi.fn().mockResolvedValue([]),
  // Resolved by default: pruneBoardTabs calls .catch() on this.
  setBoardTabs: vi.fn().mockResolvedValue(undefined),
  // The three fetches a reclaim fires against the restored id. Empty but
  // well-formed, so the orchestration tick that fetchOrchestration ends
  // in finds nothing to do rather than tripping over a stub.
  getBoard: vi.fn().mockResolvedValue({ columns: [], labels: [], cardSessions: [] }),
  getOrchestration: vi.fn().mockResolvedValue({ rails: [], conflictNotes: [] }),
  getTools: vi.fn().mockResolvedValue([]),
}));

vi.mock("./terminalRegistry", () => ({
  destroyTerminal: vi.fn(),
  setCwdForLinks: vi.fn(),
  // themeState.init() runs at the top of bootstrap() and pushes the
  // resolved theme into the terminal registry.
  applyTerminalTheme: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("./notifications", () => ({
  maybeNotifyStatusChange: vi.fn(),
  // bootstrap() starts the orchestration listeners, which register the
  // rail's voice over this module (see setRailNotificationVoice).
  setRailNotificationVoice: vi.fn(),
}));

import * as backend from "./backend";
import * as notifications from "./notifications";
import {
  layoutState,
  splitPane,
  setTabPinned,
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
  handleSessionInterrupted,
  restartDaemonInPlace,
  clearRestoredMarker,
  closePane,
  setSessionName,
  createWorkspace,
  renameWorkspace,
  switchWorkspace,
  switchWorkspaceView,
  appHubOpen,
  openAppHub,
  closeWorkspace,
  createPage,
  createSessionForCard,
  openFileInSplit,
  renamePage,
  switchPage,
  closePage,
  movePaneOrTab,
  reorderTabWithinPane,
  reorderWorkspaceAction,
  movePageAction,
  setWorkspaceRoot,
  openBoardInSplit,
  handleAgentSessionSpawned,
  retryConnect,
  bootstrap,
  teardown,
  startMainAgent,
  stopMainAgent,
  setWorkspaceColor,
  setWorkspaceFlag,
  setAgentField,
  setGitViewPrefs,
  startMainAgentWithPrompt,
  runningSessionCount,
  daemonCompat,
  daemonRequestError,
  type LayoutState,
} from "./layoutState";

function leaf(tabs: string[], activeTabIndex = 0): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex };
}

function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

function ws(
  id: string,
  pages: Page[],
  activePageId: string | null = pages[0]?.id ?? null,
  rootPath?: string
): Workspace {
  return { id, name: id, pages, activePageId, rootPath };
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
    interruptedSessionIds: new Set(),
    fileTabsById: {},
    boardTabsById: {},
    removedWorkspaces: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level store: without this, one test's seeded agent config
  // resolves in the next one.
  gavinTrees.set({});
  // Module-level store, same reason: without this, a compat verdict set
  // by one test would leak into the next one's assertions.
  daemonCompat.set(null);
  // Module-level store, same reason.
  daemonRequestError.set(null);
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
    interruptedSessionIds: new Set(),
    fileTabsById: {},
    boardTabsById: {},
    removedWorkspaces: [],
  });
});

describe("setGitViewPrefs", () => {
  it("merges the patch into the workspace's gitView and persists", async () => {
    setState([{ ...ws("ws-1", []), gitView: { diffLayout: "unified", navWidth: 160 } }], "ws-1", null);

    await setGitViewPrefs("ws-1", { diffLayout: "split" });

    expect(get(layoutState).workspaces[0].gitView).toEqual({ diffLayout: "split", navWidth: 160 });
    const persisted = vi.mocked(backend.setWorkspacesState).mock.calls.at(-1)![0];
    expect(persisted.find((w: Workspace) => w.id === "ws-1")?.gitView).toEqual({ diffLayout: "split", navWidth: 160 });
  });

  it("creates gitView when the workspace has none and leaves other workspaces alone", async () => {
    setState([ws("ws-1", []), ws("ws-2", [])], "ws-1", null);

    await setGitViewPrefs("ws-2", { skipHunkDiscardConfirm: true });

    expect(get(layoutState).workspaces[0].gitView).toBeUndefined();
    expect(get(layoutState).workspaces[1].gitView).toEqual({ skipHunkDiscardConfirm: true });
  });
});

describe("setWorkspaceRoot", () => {
  it("persists the root and starts watching", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    await setWorkspaceRoot("ws-1", "/tmp/root");

    expect(get(layoutState).workspaces[0].rootPath).toBe("/tmp/root");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    const persisted = vi.mocked(backend.setWorkspacesState).mock.calls.at(-1)![0];
    expect(persisted.find((w: Workspace) => w.id === "ws-1")?.rootPath).toBe("/tmp/root");
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-1", "/tmp/root");
    expect(backend.unwatchGavinRoot).not.toHaveBeenCalled();
  });

  it("unwatches first when re-binding to a different root", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/old" }], "ws-1", null);

    await setWorkspaceRoot("ws-1", "/tmp/new");

    expect(backend.unwatchGavinRoot).toHaveBeenCalledWith("ws-1");
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-1", "/tmp/new");
  });
});

describe("reclaiming a removed workspace's rows", () => {
  const tombstone = { id: "old-ws", name: "Gavin", rootPath: "/repo/gavin", removedAt: 100 };

  // Module-level stores, and fetchBoard/fetchOrchestration/fetchTools
  // each short-circuit on an id they already hold -- without this, only
  // the first test in this block would see the fetches fire.
  beforeEach(() => {
    kanbanState.set({});
    orchestrations.set({});
    toolRecords.set({});
  });

  function withTombstone(w: Workspace[]): void {
    setState(w, w[0]?.id ?? null, null);
    layoutState.update((s) => ({ ...s, removedWorkspaces: [tombstone] }));
  }

  it("offers the reclaim when an empty workspace is bound to the removed folder", async () => {
    withTombstone([ws("fresh", [])]);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("Gavin");
  });

  it("does not offer it for a folder nothing was removed from", async () => {
    withTombstone([ws("fresh", [])]);

    await setWorkspaceRoot("fresh", "/repo/other");

    expect(confirm).not.toHaveBeenCalled();
  });

  // Re-pointing a workspace that already holds tabs and a watch is a
  // different question from reclaiming onto an empty one.
  it("does not offer it for a workspace that already has sessions", async () => {
    withTombstone([ws("fresh", [page("p1", leaf(["a"]))])]);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not offer it for a workspace that is already bound to a root", async () => {
    withTombstone([{ ...ws("fresh", []), rootPath: "/somewhere" }]);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    expect(confirm).not.toHaveBeenCalled();
  });

  it("Start fresh binds normally and drops the record so it stops asking", async () => {
    withTombstone([ws("fresh", [])]);
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    const state = get(layoutState);
    expect(state.workspaces[0].id).toBe("fresh");
    expect(state.workspaces[0].rootPath).toBe("/repo/gavin");
    expect(state.removedWorkspaces).toEqual([]);
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("fresh", "/repo/gavin");
  });

  it("Restore re-keys the workspace, carrying its pages with it", async () => {
    withTombstone([ws("fresh", [page("p1", leaf([]))])]);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    const state = get(layoutState);
    expect(state.workspaces.map((w) => w.id)).toEqual(["old-ws"]);
    expect(state.workspaces[0].pages.map((p) => p.id)).toEqual(["p1"]);
    expect(state.workspaces[0].rootPath).toBe("/repo/gavin");
    expect(state.activeWorkspaceId).toBe("old-ws");
    // Spent: the bridge has been crossed.
    expect(state.removedWorkspaces).toEqual([]);
  });

  // The whole point of the re-key: the rows are keyed by the restored
  // id, so every watch and fetch has to name THAT one, never the id the
  // workspace was created with.
  it("Restore unwatches the new id, then watches and fetches the restored one", async () => {
    withTombstone([ws("fresh", [])]);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    expect(backend.unwatchGavinRoot).toHaveBeenCalledWith("fresh");
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("old-ws", "/repo/gavin");
    expect(backend.watchGavinRoot).not.toHaveBeenCalledWith("fresh", "/repo/gavin");
    expect(backend.getBoard).toHaveBeenCalledWith("old-ws");
    expect(backend.getOrchestration).toHaveBeenCalledWith("old-ws");
    expect(backend.getTools).toHaveBeenCalledWith("old-ws");
  });

  it("Restore persists the restored id", async () => {
    withTombstone([ws("fresh", [])]);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    const [persisted, active, removed] = vi.mocked(backend.setWorkspacesState).mock.calls.at(-1)!;
    expect(persisted.map((w: Workspace) => w.id)).toEqual(["old-ws"]);
    expect(active).toBe("old-ws");
    expect(removed).toEqual([]);
  });
});

describe("retryConnect", () => {
  it("restarts the daemon and comes back ready", async () => {
    setState([], null, null);
    layoutState.update((s) => ({ ...s, status: "error", errorMessage: "older than this app" }));
    vi.mocked(backend.restartDaemon).mockResolvedValue(undefined);
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);

    await retryConnect();

    expect(backend.restartDaemon).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(get(layoutState).status).toBe("ready");
    });
  });

  it("surfaces a failed restart", async () => {
    layoutState.update((s) => ({ ...s, status: "error", errorMessage: "boom" }));
    vi.mocked(backend.restartDaemon).mockRejectedValue(new Error("pkill unavailable"));

    await retryConnect();

    const state = get(layoutState);
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("pkill unavailable");
  });
});

describe("handleAgentSessionSpawned", () => {
  it("appends to an existing Agents page without changing the active page", () => {
    const agents = { ...page("agents-1", leaf(["a1"])), name: "Agents" };
    setState([ws("ws-1", [page("page-1", leaf(["a"])), agents], "page-1")], "ws-1", "a");

    handleAgentSessionSpawned("ws-1", "spawned-1");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[1].layout).toEqual(leaf(["a1", "spawned-1"], 1));
    expect(state.workspaces[0].activePageId).toBe("page-1");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  it("creates the Agents page when absent, keeping the active page", () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))], "page-1")], "ws-1", "a");

    handleAgentSessionSpawned("ws-1", "spawned-1");

    const state = get(layoutState);
    const agents = state.workspaces[0].pages.find((p) => p.name === "Agents");
    expect(agents?.layout).toEqual(leaf(["spawned-1"]));
    expect(state.workspaces[0].activePageId).toBe("page-1");
  });

  it("kills the session when the workspace no longer exists", () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    handleAgentSessionSpawned("ws-gone", "spawned-1");

    expect(backend.killSession).toHaveBeenCalledWith("spawned-1");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });
});

describe("openBoardInSplit", () => {
  it("splits beside the anchor, records the board tab, persists, spawns nothing", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await openBoardInSplit("a", "ws-1", "/ws/auth");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout.type).toBe("split");
    const boardTabIds = Object.keys(state.boardTabsById);
    expect(boardTabIds).toHaveLength(1);
    expect(state.boardTabsById[boardTabIds[0]]).toEqual({ workspaceId: "ws-1", contextFolder: "/ws/auth" });
    expect(state.focusedSessionId).toBe(boardTabIds[0]);
    expect(backend.setBoardTabs).toHaveBeenCalledWith(state.boardTabsById);
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});

describe("closing board tabs", () => {
  it("closeSession on a board tab prunes it without killing anything", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "bt-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({
      ...s,
      boardTabsById: { "bt-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" } },
    }));

    await closeSession("bt-1");

    expect(backend.killSession).not.toHaveBeenCalled();
    expect(get(layoutState).boardTabsById).toEqual({});
    expect(backend.setBoardTabs).toHaveBeenCalledWith({});
  });
});

// A tab is a board (or a file) only because boardTabsById/fileTabsById say
// so; Pane.svelte renders everything else as a <TerminalPane>. So a state
// that still has the tab in a layout tree but no longer in its map is not
// a harmless in-between: Svelte renders it, the pane mounts, fit() asks
// the daemon to resize an id it has never heard of, and the daemon's
// "unknown session" comes back on the streaming connection as a
// daemon-error -- the full-window "Couldn't connect to the daemon"
// overlay. These assert on every state the store PASSES THROUGH, because
// the settled result was always correct; only the order was wrong.
describe("non-session tabs are never orphaned mid-close", () => {
  async function statesDuring(action: () => Promise<void>): Promise<LayoutState[]> {
    const seen: LayoutState[] = [];
    const stop = layoutState.subscribe((s) => seen.push(s));
    await action();
    stop();
    return seen;
  }

  function tabIdsInTrees(s: LayoutState): string[] {
    return s.workspaces.flatMap((w) => w.pages.flatMap((p) => allSessionIds(p.layout)));
  }

  /// States where `tabId` is still in a tree with nothing left to classify
  /// it -- i.e. states that would render a terminal for a non-session id.
  function orphanedIn(states: LayoutState[], tabId: string): LayoutState[] {
    return states.filter(
      (s) => tabIdsInTrees(s).includes(tabId) && !s.boardTabsById[tabId] && !s.fileTabsById[tabId]
    );
  }

  function seedBoardTab(): void {
    setState([ws("ws-1", [page("page-1", leaf(["a", "bt-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({
      ...s,
      boardTabsById: { "bt-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" } },
    }));
  }

  it("closeSession removes the board tab from the tree before its map entry", async () => {
    seedBoardTab();

    const seen = await statesDuring(() => closeSession("bt-1"));

    expect(orphanedIn(seen, "bt-1")).toEqual([]);
    expect(get(layoutState).boardTabsById).toEqual({});
  });

  it("closeSession removes a file tab from the tree before its map entry", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "ft-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "ft-1": { path: "/ws/readme.md" } } }));

    const seen = await statesDuring(() => closeSession("ft-1"));

    expect(orphanedIn(seen, "ft-1")).toEqual([]);
    expect(get(layoutState).fileTabsById).toEqual({});
  });

  it("closePane removes the board tab from the tree before its map entry", async () => {
    seedBoardTab();

    const seen = await statesDuring(() => closePane("bt-1"));

    expect(orphanedIn(seen, "bt-1")).toEqual([]);
    expect(get(layoutState).boardTabsById).toEqual({});
  });

  it("closePage removes the board tab from the tree before its map entry", async () => {
    seedBoardTab();

    const seen = await statesDuring(() => closePage("ws-1", "page-1"));

    expect(orphanedIn(seen, "bt-1")).toEqual([]);
    expect(get(layoutState).boardTabsById).toEqual({});
  });

  it("closeWorkspace removes the board tab from the tree before its map entry", async () => {
    seedBoardTab();

    const seen = await statesDuring(() => closeWorkspace("ws-1"));

    expect(orphanedIn(seen, "bt-1")).toEqual([]);
    expect(get(layoutState).boardTabsById).toEqual({});
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
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-1", []);
  });

  it("starts the new session in the workspace's root directory", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))], "page-1", "/repos/gavin")], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await splitPane("a", "row");

    expect(backend.createSession).toHaveBeenCalledWith("/repos/gavin");
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

  // The sidebar can aim a split at any page of any workspace. Scoped to
  // the active page this silently did nothing (splitLeaf misses, the
  // unchanged tree is re-persisted) -- and the new session it spawns has
  // to be somewhere the user can see it.
  it("splits the target's own page and brings it on screen", async () => {
    setState(
      [
        ws("ws-1", [page("page-1", leaf(["a"]))]),
        ws("ws-2", [page("page-2", leaf(["b"])), page("page-3", leaf(["c"]))], "page-2"),
      ],
      "ws-1",
      "a"
    );
    vi.mocked(backend.createSession).mockResolvedValue("d");

    await splitPane("c", "column");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
    expect(state.workspaces[1].pages[1].layout).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [leaf(["c"]), leaf(["d"])],
    });
    expect(state.activeWorkspaceId).toBe("ws-2");
    expect(state.workspaces[1].activePageId).toBe("page-3");
    expect(getActiveView(state.workspaces[1])).toBe("terminal");
    expect(state.focusedSessionId).toBe("d");
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-2", []);
  });
});

describe("setTabPinned", () => {
  it("pins a tab on a page that is not the active one, without switching to it", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b", "c"]))], "page-1")],
      "ws-1",
      "a"
    );

    await setTabPinned("c", true);

    const state = get(layoutState);
    expect(state.workspaces[0].pages[1].layout).toEqual({
      type: "leaf",
      tabs: ["c", "b"],
      activeTabIndex: 1,
      pinned: ["c"],
    });
    // Pinning is bookkeeping -- it must not yank the view somewhere else.
    expect(state.workspaces[0].activePageId).toBe("page-1");
    expect(state.focusedSessionId).toBe("a");
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-1", []);
  });

  it("unpins through the same lookup", async () => {
    setState(
      [
        ws(
          "ws-1",
          [page("page-1", leaf(["a"])), { ...page("page-2", leaf(["b"])), layout: { type: "leaf", tabs: ["b", "c"], activeTabIndex: 0, pinned: ["b"] } }],
          "page-1"
        ),
      ],
      "ws-1",
      "a"
    );

    await setTabPinned("b", false);

    expect(get(layoutState).workspaces[0].pages[1].layout).toEqual(leaf(["b", "c"]));
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

  it("starts the new session in the workspace's root directory", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))], "page-1", "/repos/gavin")], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await addTab("a");

    expect(backend.createSession).toHaveBeenCalledWith("/repos/gavin");
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
    // The fifth argument is the owning workspace's toggles (D38); a
    // session in no workspace defaults to both on.
    const bothOn = { needsInput: true, finished: true };
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(1, "a", undefined, "working", "a", bothOn);
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(2, "a", "working", "idle", "a", bothOn);
  });

  it("resolves the notification label via sessionNames, falling back the same way tab labels do", () => {
    setState([], null, null);
    layoutState.update((s) => ({ ...s, sessionNames: { a: "my-session" } }));
    handleSessionStatusChanged("a", "waiting_for_input");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenCalledWith(
      "a",
      undefined,
      "waiting_for_input",
      "my-session",
      { needsInput: true, finished: true }
    );
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

// The signal every surface that watches a run consults. Deliberately has
// no counterpart to clearRestoredMarker: the ↻ badge is a note about the
// screen and typing dismisses it; this is a fact about the RUN, and
// typing into the shell recovery left behind does not bring the agent
// back.
describe("handleSessionInterrupted", () => {
  it("adds a session id, idempotently", () => {
    handleSessionInterrupted("a");
    handleSessionInterrupted("a");
    handleSessionInterrupted("b");
    expect(get(layoutState).interruptedSessionIds).toEqual(new Set(["a", "b"]));
  });

  it("survives the write that clears the restored marker", () => {
    handleSessionRestored("a");
    handleSessionInterrupted("a");

    clearRestoredMarker("a");

    expect(get(layoutState).restoredSessionIds.has("a")).toBe(false);
    expect(get(layoutState).interruptedSessionIds.has("a")).toBe(true);
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
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-1", []);
  });

  it("removes the page (not just clears it) when closing its only pane, and still persists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePane("a");

    const state = get(layoutState);
    expect(state.workspaces).toEqual([ws("ws-1", [], null)]);
    expect(backend.setWorkspacesState).toHaveBeenCalledWith(state.workspaces, "ws-1", []);
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

describe("the app hub", () => {
  it("starts closed", () => {
    expect(get(appHubOpen)).toBe(false);
  });

  it("stamps the workspace it switches to as last used", async () => {
    setState([ws("ws-1", []), ws("ws-2", [])], "ws-1", null);
    const before = Date.now();

    await switchWorkspace("ws-2");

    const stamped = get(layoutState).workspaces.find((w) => w.id === "ws-2")?.lastActiveAt ?? 0;
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(get(layoutState).workspaces.find((w) => w.id === "ws-1")?.lastActiveAt).toBeUndefined();
  });

  it("closes when a workspace is switched to", async () => {
    setState([ws("ws-1", []), ws("ws-2", [])], "ws-1", null);
    openAppHub();

    await switchWorkspace("ws-2");

    expect(get(appHubOpen)).toBe(false);
  });

  it("closes when the workspace switched to is the one already active", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    openAppHub();

    await switchWorkspace("ws-1");

    expect(get(appHubOpen)).toBe(false);
  });

  it("closes when a page is chosen", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))])], "ws-1", "a");
    openAppHub();

    await switchPage("ws-1", "page-2");

    expect(get(appHubOpen)).toBe(false);
  });

  it("closes when a hub view is chosen", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    openAppHub();

    await switchWorkspaceView("ws-1", "kanban");

    expect(get(appHubOpen)).toBe(false);
  });

  it("closes when a workspace is created, so the hub lands you in what it made", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    openAppHub();

    await createWorkspace("Fresh");

    expect(get(appHubOpen)).toBe(false);
  });
});

describe("switchWorkspaceView", () => {
  it("persists the new activeView for the given workspace", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await switchWorkspaceView("ws-1", "kanban");

    const state = get(layoutState);
    expect(getActiveView(state.workspaces[0])).toBe("kanban");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
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

  // The daemon's rows for a workspace are keyed by its uuid and by
  // nothing on disk, so without this record the X makes them
  // permanently unreachable.
  it("leaves a tombstone naming the workspace's root", async () => {
    setState([{ ...ws("ws-1", [page("page-1", leaf(["a"]))]), rootPath: "/repo/one" }], "ws-1", "a");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeWorkspace("ws-1");

    const [tombstone, ...rest] = get(layoutState).removedWorkspaces;
    expect(rest).toEqual([]);
    expect(tombstone).toMatchObject({ id: "ws-1", rootPath: "/repo/one" });
    // Persisted with the workspaces, not left in memory only.
    expect(vi.mocked(backend.setWorkspacesState).mock.calls.at(-1)?.[2]).toEqual([tombstone]);
  });

  it("leaves no tombstone for a workspace that was never bound to a root", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeWorkspace("ws-1");

    expect(get(layoutState).removedWorkspaces).toEqual([]);
  });

  // The X is app-side and nothing else: it used to delete the board,
  // which made closing a workspace destroy columns and labels with no
  // warning that said so. Deleting data is the wizard's job now.
  it("leaves the workspace's kanban board alone", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeWorkspace("ws-1");

    expect(backend.deleteBoard).not.toHaveBeenCalled();
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

  it("starts every session in the workspace's root directory", async () => {
    setState([ws("ws-1", [], null, "/repos/gavin")], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValueOnce("a").mockResolvedValueOnce("b");

    await createPage("ws-1", ([x, y]) => ({ type: "split", direction: "row", children: [leaf([x]), leaf([y])], sizes: [0.5, 0.5] }), 2, "Page 1");

    expect(backend.createSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(backend.createSession).mock.calls).toEqual([["/repos/gavin"], ["/repos/gavin"]]);
  });

  it("leaves the cwd unset for a workspace with no root, so the daemon picks $HOME", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("a");

    await createPage("ws-1", ([x]) => leaf([x]), 1, "Page 1");

    expect(backend.createSession).toHaveBeenCalledWith(undefined);
  });

  it("is a no-op for an unknown workspace id", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    await createPage("missing", ([x]) => leaf([x]), 1, "Page 1");

    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("opens the sessions in an explicit cwd instead of the workspace root", async () => {
    setState([ws("ws-1", [], null, "/repos/gavin")], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("a");

    await createPage("ws-1", ([x]) => leaf([x]), 1, "backend", { cwd: "/repos/gavin-backend" });

    expect(backend.createSession).toHaveBeenCalledWith("/repos/gavin-backend");
  });

  // A rail spawning its own page must not yank the human off whatever
  // they are looking at -- the Orchestration tab they just pressed Start
  // in, usually.
  it("leaves the active page alone when the caller asks not to activate", async () => {
    setState([ws("ws-1", [page("p1", leaf(["s1"]))])], "ws-1", "s1");
    const before = get(layoutState).workspaces[0].activePageId;
    vi.mocked(backend.createSession).mockResolvedValue("a");

    await createPage("ws-1", ([x]) => leaf([x]), 1, "backend", { activate: false });

    const state = get(layoutState);
    expect(state.workspaces[0].pages).toHaveLength(2);
    expect(state.workspaces[0].pages[1].name).toBe("backend");
    expect(state.workspaces[0].activePageId).toBe(before);
    expect(state.focusedSessionId).toBe("s1");
  });
});

describe("createSessionForCard", () => {
  it("creates a page and homes the session there when the workspace has zero pages", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    const sessionId = await createSessionForCard("ws-1", "", null);

    expect(sessionId).toBe("s1");
    const state = get(layoutState);
    expect(state.workspaces[0].pages).toHaveLength(1);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["s1"]));
    expect(state.focusedSessionId).toBe("s1");
  });

  it("adds a tab to the workspace's active page when it already has pages", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    const sessionId = await createSessionForCard("ws-1", "/tmp", "npm test");

    expect(sessionId).toBe("s1");
    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a", "s1"], 1));
  });

  it("passes a non-blank cwd/command straight through to backend.createSession", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    await createSessionForCard("ws-1", "/tmp/project", "npm test");

    expect(backend.createSession).toHaveBeenCalledWith("/tmp/project", "npm test");
  });

  it("converts a blank cwd and a null command to undefined for backend.createSession", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    await createSessionForCard("ws-1", "", null);

    expect(backend.createSession).toHaveBeenCalledWith(undefined, undefined);
  });

  it("returns null and surfaces an error when session creation fails", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockRejectedValue(new Error("daemon unreachable"));

    const sessionId = await createSessionForCard("ws-1", "", null);

    expect(sessionId).toBeNull();
    expect(get(layoutState).status).toBe("error");
  });

  it("is a no-op for an unknown workspace id", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    const sessionId = await createSessionForCard("missing", "", null);

    expect(sessionId).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});

describe("openFileInSplit", () => {
  it("splits the anchor's pane with a new file tab and persists both the tree and the file-tab map", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await openFileInSplit("a", "/tmp/README.md");

    const state = get(layoutState);
    const tree = state.workspaces[0].pages[0].layout;
    expect(tree.type).toBe("split");
    if (tree.type !== "split") throw new Error("expected a split");
    // The anchor keeps its own leaf; the new file tab gets the sibling leaf.
    expect(tree.children[0]).toEqual(leaf(["a"]));
    const newLeaf = tree.children[1];
    if (newLeaf.type !== "leaf") throw new Error("expected a leaf");
    const newTabId = newLeaf.tabs[0];
    expect(state.fileTabsById[newTabId]).toEqual({ path: "/tmp/README.md" });
    expect(backend.setFileTabs).toHaveBeenCalledWith({ [newTabId]: "/tmp/README.md" });
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    // A file tab is never a terminal session.
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no active page", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    await openFileInSplit("a", "/tmp/README.md");

    expect(backend.setFileTabs).not.toHaveBeenCalled();
  });
});

describe("closing file tabs", () => {
  it("closeSession unwatches a file tab instead of killing a session", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));

    await closeSession("file-1");

    expect(backend.killSession).not.toHaveBeenCalled();
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
  });

  it("prunes the closed file tab from fileTabsById and persists the smaller map", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1", "file-2"]))])], "ws-1", "a");
    layoutState.update((s) => ({
      ...s,
      fileTabsById: { "file-1": { path: "/tmp/a.md" }, "file-2": { path: "/tmp/b.md" } },
    }));

    await closeSession("file-1");

    // Only the closed one goes; the other file tab is untouched.
    expect(get(layoutState).fileTabsById).toEqual({ "file-2": { path: "/tmp/b.md" } });
    // Persisted too -- otherwise config.json keeps the dead id forever.
    expect(backend.setFileTabs).toHaveBeenCalledWith({ "file-2": "/tmp/b.md" });
  });

  it("does not touch the file-tab map when only terminal sessions close", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("a");

    expect(backend.setFileTabs).not.toHaveBeenCalled();
    expect(get(layoutState).fileTabsById).toEqual({ "file-1": { path: "/tmp/a.md" } });
  });

  it("closePane kills only the session tabs and unwatches only the file tabs", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePane("a");

    expect(backend.killSession).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
  });

  it("closeWorkspace kills only the session tabs and unwatches only the file tabs", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeWorkspace("ws-1");

    expect(backend.killSession).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
  });

  it("closePage kills only the session tabs and unwatches only the file tabs", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePage("ws-1", "page-1");

    expect(backend.killSession).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
  });
});

describe("bootstrap file tab hydration", () => {
  it("hydrates fileTabsById from the backend on bootstrap", async () => {
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockResolvedValue({ "tab-1": "/tmp/README.md" });

    await bootstrap();
    await vi.waitFor(() => {
      expect(get(layoutState).fileTabsById["tab-1"]).toEqual({ path: "/tmp/README.md" });
    });

    teardown();
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

  // The tab maps decide which layout-tree ids are boards/files and which
  // are daemon sessions. Reaching "ready" without them means the first
  // render of a restored board or file tab is a <TerminalPane> for an id
  // the daemon never had -- blank, and its resize takes the daemon's
  // "unknown session" to the whole window as a connection error.
  it("does not become ready until the tab maps are in the store", async () => {
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ "ft-1": "/ws/readme.md" }), 20))
    );
    vi.mocked(backend.getBoardTabs).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ "bt-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" } }), 20)
        )
    );

    const readyStates: LayoutState[] = [];
    const stop = layoutState.subscribe((s) => {
      if (s.status === "ready") readyStates.push(s);
    });
    await bootstrap();
    await vi.waitFor(() => expect(get(layoutState).status).toBe("ready"));
    stop();

    expect(readyStates.length).toBeGreaterThan(0);
    expect(readyStates[0].boardTabsById["bt-1"]).toEqual({ workspaceId: "ws-1", contextFolder: "/ws/auth" });
    expect(readyStates[0].fileTabsById["ft-1"]).toEqual({ path: "/ws/readme.md" });
  });

  // FileTabs/BoardTabs are managed at the very end of session::bootstrap,
  // so an invoke that lands first rejects with "state not managed" --
  // exactly what getWorkspacesState is already retried for. Swallowing it
  // once left the maps empty for the whole run.
  it("retries the tab maps when the invoke rejects because Rust isn't managed yet", async () => {
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockResolvedValue({});
    vi.mocked(backend.getBoardTabs)
      .mockRejectedValueOnce(new Error("state not managed"))
      .mockResolvedValue({ "bt-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" } });

    await bootstrap();

    await vi.waitFor(
      () => expect(get(layoutState).boardTabsById["bt-1"]).toBeDefined(),
      { timeout: 3000 }
    );
    expect(get(layoutState).status).toBe("ready");
  });
});

// The streaming connection carries Attach/WriteInput/ResizeSession, so a
// Response::Error on it means the daemon refused ONE of those -- usually
// for a session that has just exited. Reporting that as a lost connection
// is what let a stray resize replace the whole window with "Couldn't
// connect to the daemon"; the two now travel on separate events.
describe("daemon errors: refused request vs lost connection", () => {
  afterEach(() => {
    teardown();
    vi.mocked(listen).mockResolvedValue(() => {});
  });

  /// Bootstraps with `listen` capturing every handler it registers, so a
  /// test can fire a Tauri event by name the way the Rust side would.
  async function bootstrapCapturingListeners(): Promise<Map<string, (e: { payload: unknown }) => void>> {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    vi.mocked(listen).mockImplementation(async (event: string, handler: unknown) => {
      handlers.set(event, handler as (e: { payload: unknown }) => void);
      return () => {};
    });
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockResolvedValue({});
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});
    await bootstrap();
    await vi.waitFor(() => expect(get(layoutState).status).toBe("ready"));
    return handlers;
  }

  it("a refused request banners, leaving the app up", async () => {
    const handlers = await bootstrapCapturingListeners();

    handlers.get("daemon-request-error")!({ payload: "unknown session: abc" });

    expect(get(daemonRequestError)).toBe("unknown session: abc");
    expect(get(layoutState).status).toBe("ready");
    expect(get(layoutState).errorMessage).toBe("");
  });

  it("a lost connection still takes the whole window", async () => {
    const handlers = await bootstrapCapturingListeners();

    handlers.get("daemon-error")!({ payload: "daemon closed the connection" });

    expect(get(layoutState).status).toBe("error");
    expect(get(layoutState).errorMessage).toBe("daemon closed the connection");
    expect(get(daemonRequestError)).toBeNull();
  });
});

// cwd/status/restored reach the frontend only as pushes, and their
// baseline only in reply to Attach -- which runs once per app PROCESS. A
// reloaded frontend therefore has to ask for them, or every terminal tab
// loses its cwd-derived label, its status dot, and its "open this
// context's board" button until the shell's next prompt.
describe("bootstrap seeds the push-fed session maps", () => {
  afterEach(() => {
    teardown();
  });

  async function bootstrapReady(): Promise<void> {
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockResolvedValue({});
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});
    await bootstrap();
    await vi.waitFor(() => expect(get(layoutState).status).toBe("ready"));
  }

  it("fills cwd, status and the restored badge from the daemon", async () => {
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-1", cwd: "/ws/auth", status: "working", restored: true, interrupted: false },
      { id: "s-2", cwd: "/ws", status: "idle", restored: false, interrupted: false },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).cwdBySessionId["s-1"]).toBe("/ws/auth"));
    const state = get(layoutState);
    expect(state.cwdBySessionId["s-2"]).toBe("/ws");
    expect(state.sessionStatusById["s-1"]).toBe("working");
    expect(state.restoredSessionIds.has("s-1")).toBe(true);
    expect(state.restoredSessionIds.has("s-2")).toBe(false);
    // Straight into the map, never through handleSessionStatusChanged:
    // re-reading a status the human has already seen is not a transition.
    expect(notifications.maybeNotifyStatusChange).not.toHaveBeenCalled();
  });
  it("fills the interrupted set, which the restored one does not speak for", async () => {
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-agent", cwd: "/ws", status: "idle", restored: true, interrupted: true },
      { id: "s-shell", cwd: "/ws", status: "idle", restored: true, interrupted: false },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).interruptedSessionIds.has("s-agent")).toBe(true));
    const state = get(layoutState);
    // Both were restored; only one of them lost a run.
    expect(state.restoredSessionIds).toEqual(new Set(["s-agent", "s-shell"]));
    expect(state.interruptedSessionIds.has("s-shell")).toBe(false);
  });


  it("never overwrites a push that already landed", async () => {
    vi.mocked(backend.getSessionBaselines).mockImplementation(async () => {
      // A live push beats the snapshot this call is about to return.
      handleCwdChanged("s-1", "/ws/live");
      return [{ id: "s-1", cwd: "/ws/stale", status: "idle", restored: false, interrupted: false }];
    });

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).cwdBySessionId["s-1"]).toBe("/ws/live"));
  });

  it("survives the daemon refusing the query", async () => {
    vi.mocked(backend.getSessionBaselines).mockRejectedValue(new Error("state not managed"));

    await bootstrapReady();

    expect(get(layoutState).status).toBe("ready");
    expect(get(layoutState).cwdBySessionId).toEqual({});
  });

  // The fourth push-fed map, and the one the sidebar's repo chip, the
  // page rows' branch lines and the pane's git dot all read. Its baseline
  // is the same once-per-app-PROCESS Attach, so without this seed every
  // frontend load after the first shows no git anywhere -- and the
  // daemon cannot fix it by itself, because GitStatusChanged only fires
  // when the status actually CHANGES.
  it("fills the git status the sidebar's repo chip reads", async () => {
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-1", cwd: "/ws/auth", status: "idle", restored: false, interrupted: false },
      { id: "s-2", cwd: "/elsewhere", status: "idle", restored: false, interrupted: false },
    ]);
    vi.mocked(backend.getGitBaselines).mockResolvedValue([
      { repoRoot: "/ws", branch: "main", dirty: true, ahead: 2, behind: 0, hasUpstream: true },
      null,
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).gitStatusById["s-1"]).not.toBeUndefined());
    const state = get(layoutState);
    expect(state.gitStatusById["s-1"]).toEqual({
      repoRoot: "/ws",
      branch: "main",
      dirty: true,
      ahead: 2,
      behind: 0,
      hasUpstream: true,
    });
    // Asked about the very cwds the session baselines reported, in order.
    expect(backend.getGitBaselines).toHaveBeenCalledWith(["/ws/auth", "/elsewhere"]);
    // A session outside any repo is recorded as null, not left absent:
    // "checked, no repo" is a real answer and must not be re-asked.
    expect(state.gitStatusById["s-2"]).toBeNull();
  });

  it("never overwrites a git push that already landed", async () => {
    const live = { repoRoot: "/ws", branch: "live", dirty: false, ahead: 0, behind: 0, hasUpstream: false };
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-1", cwd: "/ws", status: "idle", restored: false, interrupted: false },
    ]);
    vi.mocked(backend.getGitBaselines).mockImplementation(async () => {
      handleGitStatusChanged("s-1", live);
      return [{ repoRoot: "/ws", branch: "stale", dirty: true, ahead: 9, behind: 9, hasUpstream: true }];
    });

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).gitStatusById["s-1"]).toEqual(live));
  });

  // Not fatal, and never blocks the cwd/status seed it rides along with:
  // git can be missing, slow, or refuse a repo outright.
  it("keeps the cwd seed when the git half fails", async () => {
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-1", cwd: "/ws", status: "idle", restored: false, interrupted: false },
    ]);
    vi.mocked(backend.getGitBaselines).mockRejectedValue(new Error("git was not found on PATH"));

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).cwdBySessionId["s-1"]).toBe("/ws"));
    expect(get(layoutState).gitStatusById).toEqual({});
  });
});

/// Puts an [agent] block on a workspace's root context, the way a
/// watcher push would. resolvedAgentFor reads gavinTrees directly, so
/// this is how a test controls the resolved command/file.
function seedAgentConfig(
  workspaceId: string,
  agent: { profile: string | null; file: string | null; command: string | null }
): void {
  gavinTrees.update((t) => ({
    ...t,
    [workspaceId]: {
      rootPath: "/tmp/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/tmp/ws",
          kind: "root",
          name: "ws",
          plans: [],
          docs: [],
          specs: [],
          hasPrd: false,
          configWarning: false,
          agent,
        },
      ],
    },
  }));
}

describe("workspace settings", () => {
  it("setWorkspaceColor normalizes and persists", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceColor("ws-1", "#A78BFA");
    expect(get(layoutState).workspaces[0].color).toBe("#a78bfa");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("setWorkspaceColor rejects junk by storing the default", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceColor("ws-1", "red; background: url(x)");
    expect(get(layoutState).workspaces[0].color).toBe("#4a9eff");
  });

  it("setWorkspaceFlag flips one toggle without touching the other", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceFlag("ws-1", "notifyFinished", false);
    const w = get(layoutState).workspaces[0];
    expect(w.notifyFinished).toBe(false);
    expect(w.notifyNeedsInput).not.toBe(false);
  });

  it("setAgentField writes config.toml through the daemon, not config.json", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    vi.mocked(backend.setWorkspacesState).mockClear();

    await setAgentField("ws-1", "command", "claude --model opus");

    expect(backend.setRootConfigField).toHaveBeenCalledWith("/tmp/ws", "command", "claude --model opus");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  it("setAgentField does nothing without a root", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.setRootConfigField).mockClear();
    await setAgentField("ws-1", "command", "x");
    expect(backend.setRootConfigField).not.toHaveBeenCalled();
  });
});

describe("main agent session", () => {
  // Was driven by a workspace.agentCommand field; the command now comes
  // from .gavin-root/config.toml via the gavin tree (D41), so the test
  // seeds the tree instead.
  it("startMainAgent spawns at the root with the configured command and persists", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    seedAgentConfig("ws-1", { profile: "claude-code", file: null, command: "claude --model opus" });
    vi.mocked(backend.createSession).mockResolvedValue("agent-1");

    await startMainAgent("ws-1");

    expect(backend.createSession).toHaveBeenCalledWith("/tmp/ws", "claude --model opus");
    expect(get(layoutState).workspaces[0].mainSessionId).toBe("agent-1");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("startMainAgent falls back to claude and refuses without a root or when one runs", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("agent-1");
    await startMainAgent("ws-1");
    expect(backend.createSession).toHaveBeenCalledWith("/tmp/ws", "claude");

    // Already running: no second spawn.
    await startMainAgent("ws-1");
    expect(backend.createSession).toHaveBeenCalledOnce();

    // No root: nothing at all.
    setState([ws("ws-2", [])], "ws-2", null);
    vi.mocked(backend.createSession).mockClear();
    await startMainAgent("ws-2");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("stopMainAgent kills the session and clears the id", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws", mainSessionId: "agent-1" }], "ws-1", null);

    await stopMainAgent("ws-1");

    expect(backend.killSession).toHaveBeenCalledWith("agent-1");
    expect(get(layoutState).workspaces[0].mainSessionId).toBeUndefined();
  });

  it("startMainAgentWithPrompt spawns with the composed prompt and records the session", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    seedAgentConfig("ws-1", { profile: "claude-code", file: null, command: "claude" });
    vi.mocked(backend.createSession).mockResolvedValue("agent-1");

    await startMainAgentWithPrompt("ws-1", "Use the gavin-write-prd skill.");

    expect(backend.createSession).toHaveBeenCalledWith(
      "/tmp/ws",
      "claude 'Use the gavin-write-prd skill.'"
    );
    expect(get(layoutState).workspaces[0].mainSessionId).toBe("agent-1");
  });

  it("startMainAgentWithPrompt refuses when an agent is already running", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws", mainSessionId: "already" }], "ws-1", null);
    vi.mocked(backend.createSession).mockClear();
    await startMainAgentWithPrompt("ws-1", "anything");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("handleSessionExited clears the owning workspace's main session only", async () => {
    setState(
      [
        { ...ws("ws-1", []), mainSessionId: "agent-1" },
        { ...ws("ws-2", []), mainSessionId: "agent-2" },
      ],
      "ws-1",
      null
    );

    handleSessionExited("agent-1");

    const after = get(layoutState).workspaces;
    expect(after[0].mainSessionId).toBeUndefined();
    expect(after[1].mainSessionId).toBe("agent-2");
  });
});

describe("restartDaemonInPlace", () => {
  it("reloads workspaces from the daemon and leaves the app up", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    layoutState.update((s) => ({ ...s, status: "ready" }));
    vi.mocked(backend.restartDaemon).mockResolvedValue(undefined);
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({
      workspaces: [ws("ws-1", [])],
      activeWorkspaceId: "ws-1",
    });

    await restartDaemonInPlace();

    expect(backend.restartDaemon).toHaveBeenCalled();
    expect(backend.getWorkspacesState).toHaveBeenCalled();
    // Unlike retryConnect, this never drops the app into "connecting" --
    // the window stays live through the restart.
    expect(get(layoutState).status).toBe("ready");
  });

  it("throws so the caller can show the failure, and leaves the app ready", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    layoutState.update((s) => ({ ...s, status: "ready" }));
    vi.mocked(backend.restartDaemon).mockRejectedValue(new Error("pkill unavailable"));

    await expect(restartDaemonInPlace()).rejects.toThrow("pkill unavailable");
    expect(get(layoutState).status).toBe("ready");
  });

  // The verdict is what the caller compares against the pre-restart one to
  // tell "restarted onto a newer daemon" from "restarted onto the same
  // stale binary" -- the whole difference between the banner's CTA looking
  // dead and looking honest. Fire-and-forget refreshing would hand the
  // caller nothing to compare.
  it("hands back the verdict the restart landed on", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    layoutState.update((s) => ({ ...s, status: "ready" }));
    daemonCompat.set({ daemonVersion: 16, appVersion: 17, degraded: true });
    vi.mocked(backend.restartDaemon).mockResolvedValue(undefined);
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({
      workspaces: [ws("ws-1", [])],
      activeWorkspaceId: "ws-1",
    });
    vi.mocked(backend.daemonCompat).mockResolvedValue({
      daemonVersion: 17,
      appVersion: 17,
      degraded: false,
    });

    const after = await restartDaemonInPlace();

    expect(after).toEqual({ daemonVersion: 17, appVersion: 17, degraded: false });
    expect(get(daemonCompat)).toEqual(after);
  });

  // A failed probe must not read as "the daemon changed": the retained
  // verdict is the honest answer, and returning null instead would make
  // the caller report an unknown version rather than the one it still has.
  it("falls back to the retained verdict when the probe fails", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    layoutState.update((s) => ({ ...s, status: "ready" }));
    const retained = { daemonVersion: 16, appVersion: 17, degraded: true };
    daemonCompat.set(retained);
    vi.mocked(backend.restartDaemon).mockResolvedValue(undefined);
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({
      workspaces: [ws("ws-1", [])],
      activeWorkspaceId: "ws-1",
    });
    vi.mocked(backend.daemonCompat).mockRejectedValue(new Error("ipc hiccup"));

    expect(await restartDaemonInPlace()).toEqual(retained);
  });

  // The regression this guards: DaemonCompatBanner's "Restart daemon"
  // button calls this function (not retryConnect, which unconditionally
  // flips status to "connecting" and, on failure, "error" -- blanking the
  // working app behind an overlay the moment the user acts on the very
  // banner explaining the app still works). A caller catching the thrown
  // error is only a safe pattern if `status` truly never moves on this
  // path; this test is what would fail if that guarantee broke.
  it("does not touch status or the daemonCompat verdict when the restart fails", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    layoutState.update((s) => ({ ...s, status: "ready" }));
    const previousCompat = { daemonVersion: 9, appVersion: 12, degraded: true };
    daemonCompat.set(previousCompat);
    vi.mocked(backend.restartDaemon).mockRejectedValue(new Error("pkill unavailable"));

    await expect(restartDaemonInPlace()).rejects.toThrow("pkill unavailable");

    expect(get(layoutState).status).toBe("ready");
    // The verdict the banner is still showing must survive a failed
    // restart untouched -- the user is exactly where they were, with an
    // explanation, not looking at a blanked-out or stale-cleared banner.
    expect(get(daemonCompat)).toEqual(previousCompat);
  });
});

// The set of sessions a daemon restart would end -- what DaemonCompatBanner
// sizes its "restarting will end N running agents" warning from. Tested
// directly against a hand-built LayoutState rather than through the store,
// since the point is the derivation itself, not any store plumbing.
describe("runningSessionCount", () => {
  function state(overrides: Partial<LayoutState>): LayoutState {
    return {
      status: "ready",
      errorMessage: "",
      workspaces: [],
      activeWorkspaceId: null,
      focusedSessionId: null,
      cwdBySessionId: {},
      sessionNames: {},
      sessionStatusById: {},
      gitStatusById: {},
      restoredSessionIds: new Set(),
      interruptedSessionIds: new Set(),
      fileTabsById: {},
      boardTabsById: {},
      removedWorkspaces: [],
      ...overrides,
    };
  }

  it("counts every session tab across every page and workspace", () => {
    const s = state({
      workspaces: [
        ws("w1", [page("p1", leaf(["a", "b"])), page("p2", leaf(["c"]))]),
        ws("w2", [page("p3", leaf(["d"]))]),
      ],
    });
    expect(runningSessionCount(s)).toBe(4);
  });

  it("counts a main agent session, which lives outside every page tree", () => {
    const s = state({
      workspaces: [{ ...ws("w1", [page("p1", leaf(["a"]))]), mainSessionId: "main-1" }],
    });
    expect(runningSessionCount(s)).toBe(2);
  });

  it("excludes file and board tabs -- the daemon has never heard of them", () => {
    const s = state({
      workspaces: [ws("w1", [page("p1", leaf(["a", "file-1", "board-1"]))])],
      fileTabsById: { "file-1": { path: "/tmp/x" } },
      boardTabsById: { "board-1": { workspaceId: "w1", contextFolder: "." } },
    });
    expect(runningSessionCount(s)).toBe(1);
  });

  it("dedupes an id that happens to appear on more than one page", () => {
    const s = state({
      workspaces: [ws("w1", [page("p1", leaf(["a"])), page("p2", leaf(["a"]))])],
    });
    expect(runningSessionCount(s)).toBe(1);
  });

  it("is zero with no workspaces", () => {
    expect(runningSessionCount(state({}))).toBe(0);
  });
});
