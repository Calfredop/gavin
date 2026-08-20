import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./backend", () => ({ gavinRootExists: vi.fn() }));
vi.mock("./layoutState", () => ({
  closeWorkspace: vi.fn().mockResolvedValue(undefined),
  closePage: vi.fn().mockResolvedValue(undefined),
  movePageAction: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  setWorkspaceRoot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./confirmClose", () => ({
  confirmWorkspaceClose: vi.fn().mockResolvedValue(true),
  confirmPageClose: vi.fn().mockResolvedValue(true),
  confirmTabClose: vi.fn().mockResolvedValue(true),
}));

import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { gavinRootExists } from "./backend";
import {
  closeWorkspace,
  closePage,
  movePageAction,
  switchWorkspaceView,
  switchToSessionInPage,
  closeSession,
  setWorkspaceRoot,
} from "./layoutState";
import { confirmPageClose } from "./confirmClose";
import {
  buildWorkspaceMenuEntries,
  buildPageMenuEntries,
  buildSessionRowMenuEntries,
  changeWorkspaceRoot,
  type SidebarMenuHooks,
} from "./sidebarMenu";
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
  return { startRenameWorkspace: vi.fn(), startRenamePage: vi.fn(), newPage: vi.fn(), reportError: vi.fn() };
}
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
});

describe("buildWorkspaceMenuEntries", () => {
  it("lists the regular workspace menu", () => {
    const labels = items(buildWorkspaceMenuEntries(ws("w1", [page("p1")], "/r"), hooks())).map((e) => e.label);
    expect(labels).toEqual(["Rename…", "New Page", "Open Root in Finder", "Change Root Folder…", "Close Workspace"]);
  });
  it("gives Unfiled only New Page", () => {
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
    const labels = items(buildPageMenuEntries(all[0], all[0].pages[0], all, hooks())).map((e) => e.label);
    expect(labels).toEqual([
      "Rename…",
      "New Page",
      "Move to w2",
      `Move to ${UNFILED_WORKSPACE_ID}`,
      "Close Other Pages",
      "Close Page",
    ]);
  });
  it("moves a page to the end of the target workspace", () => {
    find(buildPageMenuEntries(all[0], all[0].pages[0], all, hooks()), "Move to w2").onPick();
    expect(movePageAction).toHaveBeenCalledWith("p1", "w2", 1);
  });
  it("closes other pages sequentially with confirms and stops on decline", async () => {
    const three = ws("w1", [page("p1"), page("p2"), page("p3")]);
    vi.mocked(confirmPageClose).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    find(buildPageMenuEntries(three, three.pages[0], [three], hooks()), "Close Other Pages").onPick();
    await flush();
    expect(vi.mocked(closePage).mock.calls).toEqual([["w1", "p2"]]);
  });
  it("disables Close Other Pages when the page is alone", () => {
    const entries = buildPageMenuEntries(all[1], all[1].pages[0], all, hooks());
    expect(find(entries, "Close Other Pages").disabled).toBe(true);
    expect(find(entries, "Close Page").danger).toBe(true);
  });
});

describe("buildSessionRowMenuEntries", () => {
  const w = ws("w1", [page("p1")]);
  it("jumps, opens cwd, closes", async () => {
    const entries = buildSessionRowMenuEntries(w, w.pages[0], "s1", "/cwd", hooks());
    expect(items(entries).map((e) => e.label)).toEqual(["Jump to Session", "Open cwd in Finder", "Close Session"]);
    find(entries, "Jump to Session").onPick();
    expect(switchWorkspaceView).toHaveBeenCalledWith("w1", "terminal");
    expect(switchToSessionInPage).toHaveBeenCalledWith("w1", "p1", "s1");
    find(entries, "Open cwd in Finder").onPick();
    expect(openPath).toHaveBeenCalledWith("/cwd");
    find(entries, "Close Session").onPick();
    await flush();
    expect(closeSession).toHaveBeenCalledWith("s1");
  });
  it("disables Open cwd without a cwd", () => {
    expect(find(buildSessionRowMenuEntries(w, w.pages[0], "s1", null, hooks()), "Open cwd in Finder").disabled).toBe(
      true
    );
  });
});
