import { describe, it, expect, vi, beforeEach } from "vitest";

// The tab row's menu delegates to the REAL buildTabMenuEntries, so this
// file has to stand in for everything that builder reaches for too.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./backend", () => ({ gavinRootExists: vi.fn() }));
vi.mock("./layoutState", () => ({
  closeWorkspace: vi.fn().mockResolvedValue(undefined),
  closePage: vi.fn().mockResolvedValue(undefined),
  movePageAction: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  handOffWorkspace: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  setWorkspaceRoot: vi.fn().mockResolvedValue(undefined),
  setTabPinned: vi.fn().mockResolvedValue(undefined),
  splitPane: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./tabActions", () => ({ closeTabs: vi.fn().mockResolvedValue(undefined) }));
// The window registry, with the one thing the real module cannot give a
// test: which window it is. `currentWindowLabel` reads an object Tauri
// injects into the page, so outside the app it is always "main" -- and
// "main" cannot exercise the case where a workspace's own window is
// asked to hand it over.
const windowState = vi.hoisted(() => ({ label: "main" }));
vi.mock("./appWindowState", async () => {
  const { writable, get } = await import("svelte/store");
  const store = writable<Record<string, string>>({});
  return {
    workspaceWindows: store,
    currentWorkspaceWindows: () => get(store),
    currentWindowLabel: () => windowState.label,
    isMainWindow: () => windowState.label === "main",
  };
});
vi.mock("./confirmClose", () => ({
  confirmWorkspaceClose: vi.fn().mockResolvedValue(true),
  confirmPageClose: vi.fn().mockResolvedValue(true),
  confirmTabClose: vi.fn().mockResolvedValue(true),
}));

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { gavinRootExists } from "./backend";
import {
  closeWorkspace,
  closePage,
  handOffWorkspace,
  movePageAction,
  switchWorkspaceView,
  switchToSessionInPage,
  closeSession,
  setWorkspaceRoot,
  setTabPinned,
  splitPane,
} from "./layoutState";
import { workspaceWindows } from "./appWindowState";
import { closeTabs } from "./tabActions";
import { confirmPageClose } from "./confirmClose";
import {
  buildWorkspaceMenuEntries,
  buildPageMenuEntries,
  buildSessionRowMenuEntries,
  changeWorkspaceRoot,
  type SidebarMenuHooks,
} from "./sidebarMenu";
import type { TabMenuContext } from "./tabMenu";
import type { PageTabState } from "./sidebarSummary";
import { isSeparator, type ContextMenuItem, type ContextMenuEntry } from "./contextMenu";
import { UNFILED_WORKSPACE_ID, type Workspace, type Page } from "./workspace";

const page = (id: string): Page => ({
  id,
  name: id,
  layout: { type: "leaf", tabs: [`${id}-s`], activeTabIndex: 0 },
  focusedSessionId: null,
});
const ws = (id: string, pages: Page[], rootPath?: string): Workspace => ({
  id,
  name: id,
  pages,
  activePageId: pages[0]?.id ?? null,
  ...(rootPath ? { rootPath } : {}),
});

function hooks(): SidebarMenuHooks {
  return {
    startRenameWorkspace: vi.fn(),
    startRenamePage: vi.fn(),
    startRenameSession: vi.fn(),
    newPage: vi.fn(),
    confirmCloseIdle: vi.fn(),
    reportError: vi.fn(),
  };
}
// Every page fixture's tab is a terminal session with no status
// recorded, which pageAgentsSummary (and so idleTabsOnPage) reads as
// idle -- the state a page menu is opened in by default.
const tabState = (extra: Partial<PageTabState> = {}): PageTabState => ({
  sessionStatusById: {},
  fileTabsById: {},
  boardTabsById: {},
  cardTabsById: {},
  ...extra,
});
const items = (entries: ContextMenuEntry[]) => entries.filter((e): e is ContextMenuItem => !isSeparator(e));
const find = (entries: ContextMenuEntry[], label: string) => {
  const item = items(entries).find((e) => e.label === label);
  if (!item) throw new Error(`no entry ${label}`);
  return item;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(confirmPageClose).mockResolvedValue(true);
  // Nothing has moved: the empty map means every workspace is in the main
  // window, and this test file is that window unless it says otherwise.
  workspaceWindows.set({});
  windowState.label = "main";
});

describe("buildWorkspaceMenuEntries", () => {
  it("lists the regular workspace menu", () => {
    const labels = items(buildWorkspaceMenuEntries(ws("w1", [page("p1")], "/r"), hooks())).map((e) => e.label);
    expect(labels).toEqual([
      "Rename…",
      "New Page",
      "Open in New Window",
      "Open Root in Finder",
      "Change Root Folder…",
      "Close Workspace",
    ]);
  });
  it("offers a window for a workspace that is here, and the way back to one that is not", () => {
    find(buildWorkspaceMenuEntries(ws("w1", [], "/r"), hooks()), "Open in New Window").onPick();
    expect(handOffWorkspace).toHaveBeenCalledWith("w1");

    // Never a second window onto the same workspace: once it has one, the
    // only thing left to offer is a way back to it.
    workspaceWindows.set({ w1: "ws-w1" });
    const entries = buildWorkspaceMenuEntries(ws("w1", [], "/r"), hooks());
    expect(items(entries).map((e) => e.label)).not.toContain("Open in New Window");
    find(entries, "Show in Its Window").onPick();
    expect(handOffWorkspace).toHaveBeenCalledTimes(2);
  });
  // Both gestures would end where they started, so the menu offers
  // neither rather than offering a no-op.
  it("withdraws the entry in the window the workspace already is", () => {
    workspaceWindows.set({ w1: "ws-w1" });
    windowState.label = "ws-w1";
    const labels = items(buildWorkspaceMenuEntries(ws("w1", [], "/r"), hooks())).map((e) => e.label);
    expect(labels).toEqual([
      "Rename…",
      "New Page",
      "Open Root in Finder",
      "Change Root Folder…",
      "Close Workspace",
    ]);
  });
  it("gives the Scratchpad only New Page", () => {
    const entries = buildWorkspaceMenuEntries(ws(UNFILED_WORKSPACE_ID, []), hooks());
    expect(items(entries).map((e) => e.label)).toEqual(["New Page"]);
  });
  it("disables Open Root without a root and opens it with one", () => {
    expect(find(buildWorkspaceMenuEntries(ws("w1", []), hooks()), "Open Root in Finder").disabled).toBe(true);
    find(buildWorkspaceMenuEntries(ws("w1", [], "/r"), hooks()), "Open Root in Finder").onPick();
    expect(openPath).toHaveBeenCalledWith("/r");
  });
  it("renames, adds pages, and closes (danger) through the right calls", async () => {
    const h = hooks();
    const entries = buildWorkspaceMenuEntries(ws("w1", [], "/r"), h);
    find(entries, "Rename…").onPick();
    expect(h.startRenameWorkspace).toHaveBeenCalledWith("w1");
    find(entries, "New Page").onPick();
    expect(h.newPage).toHaveBeenCalledWith("w1");
    const close = find(entries, "Close Workspace");
    expect(close.danger).toBe(true);
    close.onPick();
    await flush();
    expect(closeWorkspace).toHaveBeenCalledWith("w1");
  });
});

describe("changeWorkspaceRoot", () => {
  it("sets the root directly when the folder already has a gavin root", async () => {
    vi.mocked(open).mockResolvedValue("/new");
    vi.mocked(gavinRootExists).mockResolvedValue(true);
    await changeWorkspaceRoot("w1", vi.fn());
    expect(setWorkspaceRoot).toHaveBeenCalledWith("w1", "/new");
  });
  it("sends the user to the Home tab when the folder is not initialised", async () => {
    vi.mocked(open).mockResolvedValue("/plain");
    vi.mocked(gavinRootExists).mockResolvedValue(false);
    const report = vi.fn();
    await changeWorkspaceRoot("w1", report);
    expect(setWorkspaceRoot).not.toHaveBeenCalled();
    expect(switchWorkspaceView).toHaveBeenCalledWith("w1", "home");
    expect(report).toHaveBeenCalledWith(expect.stringContaining("Home tab"));
  });
  it("does nothing when the picker is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await changeWorkspaceRoot("w1", vi.fn());
    expect(gavinRootExists).not.toHaveBeenCalled();
  });
  it("reports a failure from the picker or the backend instead of throwing", async () => {
    vi.mocked(open).mockRejectedValue(new Error("picker broke"));
    const report = vi.fn();
    await expect(changeWorkspaceRoot("w1", report)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("picker broke"));
  });
  it("the menu entry reaches changeWorkspaceRoot with the hook's reportError", async () => {
    vi.mocked(open).mockRejectedValue(new Error("boom"));
    const h = hooks();
    find(buildWorkspaceMenuEntries(ws("w1", [], "/r"), h), "Change Root Folder…").onPick();
    await flush();
    expect(h.reportError).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

describe("buildPageMenuEntries", () => {
  const all = [ws("w1", [page("p1"), page("p2")]), ws("w2", [page("q1")]), ws(UNFILED_WORKSPACE_ID, [])];
  it("lists the page menu with a Move entry per other workspace", () => {
    const labels = items(buildPageMenuEntries(all[0], all[0].pages[0], all, tabState(), hooks())).map((e) => e.label);
    expect(labels).toEqual([
      "Rename…",
      "New Page",
      "Move to w2",
      `Move to ${UNFILED_WORKSPACE_ID}`,
      "Close Idle Tabs",
      "Close Other Pages",
      "Close Page",
    ]);
  });
  it("moves a page to the end of the target workspace", () => {
    find(buildPageMenuEntries(all[0], all[0].pages[0], all, tabState(), hooks()), "Move to w2").onPick();
    expect(movePageAction).toHaveBeenCalledWith("p1", "w2", 1);
  });
  it("closes other pages sequentially with confirms and stops on decline", async () => {
    const three = ws("w1", [page("p1"), page("p2"), page("p3")]);
    vi.mocked(confirmPageClose).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    find(buildPageMenuEntries(three, three.pages[0], [three], tabState(), hooks()), "Close Other Pages").onPick();
    await flush();
    expect(vi.mocked(closePage).mock.calls).toEqual([["w1", "p2"]]);
  });
  it("hands the frozen idle set and its prompt to the confirm hook", () => {
    const h = hooks();
    find(buildPageMenuEntries(all[0], all[0].pages[0], all, tabState(), h), "Close Idle Tabs").onPick();
    expect(h.confirmCloseIdle).toHaveBeenCalledWith({
      ids: ["p1-s"],
      prompt: expect.objectContaining({ title: 'Close 1 idle tab on "p1"?', confirmLabel: "Close 1 tab" }),
    });
  });
  it("disables Close Idle Tabs when every tab is busy", () => {
    const state = tabState({ sessionStatusById: { "p1-s": "working" } });
    const entry = find(buildPageMenuEntries(all[0], all[0].pages[0], all, state, hooks()), "Close Idle Tabs");
    expect(entry.disabled).toBe(true);
    expect(entry.danger).toBe(true);
  });
  it("disables Close Other Pages when the page is alone", () => {
    const entries = buildPageMenuEntries(all[1], all[1].pages[0], all, tabState(), hooks());
    expect(find(entries, "Close Other Pages").disabled).toBe(true);
    expect(find(entries, "Close Page").danger).toBe(true);
  });
});

describe("buildSessionRowMenuEntries", () => {
  const w = ws("w1", [page("p1")]);
  const rowCtx = (extra: Partial<TabMenuContext> = {}): TabMenuContext => ({
    tabId: "s1",
    kind: "terminal",
    path: "/cwd",
    pinned: false,
    tabs: ["p", "s0", "s1", "s2"],
    pinnedTabs: ["p"],
    ...extra,
  });

  it("offers the jump plus the whole tab menu, in that order", () => {
    const entries = buildSessionRowMenuEntries(w, w.pages[0], rowCtx(), hooks());
    expect(items(entries).map((e) => e.label)).toEqual([
      "Jump to Session",
      "Close",
      "Close Others",
      "Close to the Right",
      "Close to the Left",
      "Pin",
      "Split Right",
      "Split Down",
      "Rename…",
      "Open Folder in Finder",
      "Copy Path",
    ]);
  });

  it("jumps to the row's own page, switching the view first", () => {
    find(buildSessionRowMenuEntries(w, w.pages[0], rowCtx(), hooks()), "Jump to Session").onPick();
    expect(switchWorkspaceView).toHaveBeenCalledWith("w1", "terminal");
    expect(switchToSessionInPage).toHaveBeenCalledWith("w1", "p1", "s1");
  });

  it("fires the tab actions against the row's tab", async () => {
    const h = hooks();
    const entries = buildSessionRowMenuEntries(w, w.pages[0], rowCtx(), h);
    find(entries, "Close").onPick();
    await flush();
    expect(closeSession).toHaveBeenCalledWith("s1");
    // Never the clicked tab, never the pinned one.
    find(entries, "Close Others").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["s0", "s2"]);
    find(entries, "Close to the Right").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["s2"]);
    find(entries, "Pin").onPick();
    expect(setTabPinned).toHaveBeenCalledWith("s1", true);
    find(entries, "Split Right").onPick();
    expect(splitPane).toHaveBeenCalledWith("s1", "row");
    find(entries, "Rename…").onPick();
    expect(h.startRenameSession).toHaveBeenCalledWith("s1");
    find(entries, "Open Folder in Finder").onPick();
    expect(openPath).toHaveBeenCalledWith("/cwd");
    find(entries, "Copy Path").onPick();
    expect(writeText).toHaveBeenCalledWith("/cwd");
  });

  it("names the jump for a tab no agent runs, and drops the terminal-only actions", () => {
    const entries = buildSessionRowMenuEntries(w, w.pages[0], rowCtx({ kind: "file", path: "/repo/a.md" }), hooks());
    const labels = items(entries).map((e) => e.label);
    expect(labels[0]).toBe("Jump to Tab");
    expect(labels).not.toContain("Split Right");
    expect(labels).not.toContain("Rename…");
    find(entries, "Reveal in Finder").onPick();
    expect(revealItemInDir).toHaveBeenCalledWith("/repo/a.md");
  });

  it("disables the path entries when the row has no path", () => {
    const entries = buildSessionRowMenuEntries(w, w.pages[0], rowCtx({ path: null }), hooks());
    expect(find(entries, "Open Folder in Finder").disabled).toBe(true);
    expect(find(entries, "Copy Path").disabled).toBe(true);
  });
});
