import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LayoutNode } from "./layout";
import type { Page, Workspace } from "./workspace";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
}));

import { confirm } from "@tauri-apps/plugin-dialog";
import { layoutState } from "./layoutState";
import { confirmTabClose, confirmPaneClose, confirmPageClose, confirmWorkspaceClose } from "./confirmClose";

beforeEach(() => {
  vi.clearAllMocks();
});

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

function ws(id: string, pages: Page[], activePageId: string | null = pages[0]?.id ?? null): Workspace {
  return { id, name: id, pages, activePageId };
}

function setActivePage(workspaces: Workspace[], activeWorkspaceId: string | null): void {
  layoutState.set({
    status: "ready",
    errorMessage: "",
    workspaces,
    activeWorkspaceId,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
    gitStatusById: {},
    restoredSessionIds: new Set(),
    fileTabsById: {},
  });
}

describe("confirmTabClose", () => {
  it("skips the prompt and resolves true when the tab isn't the last one in its pane", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1");
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prompts and returns the dialog's answer when the tab is the last one in its pane", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("last one in this pane");
  });

  it("propagates a decline", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await confirmTabClose("a")).toBe(false);
  });
});

describe("confirmPaneClose", () => {
  it("always prompts, even for a single-tab pane, and reports the session count", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b", "c"]))])], "ws-1");
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmPaneClose("b");
    expect(result).toBe(true);
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("3 terminal sessions");
  });

  it("pluralizes correctly for a single session", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(confirm).mockResolvedValue(true);
    await confirmPaneClose("a");
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("1 terminal session ");
  });
});

describe("confirmPageClose", () => {
  it("always prompts and reports the page's session count", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))])], "ws-1");
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmPageClose("ws-1", "page-2");
    expect(result).toBe(true);
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("1 terminal session ");
  });

  it("propagates a decline", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await confirmPageClose("ws-1", "page-1")).toBe(false);
  });
});

describe("confirmWorkspaceClose", () => {
  it("always prompts and reports the total session count across every page", async () => {
    setActivePage(
      [ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))])],
      "ws-1"
    );
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmWorkspaceClose("ws-1");
    expect(result).toBe(true);
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("3 terminal sessions");
  });

  it("propagates a decline", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await confirmWorkspaceClose("ws-1")).toBe(false);
  });
});

describe("file tabs are not counted as terminal sessions", () => {
  it("confirmTabClose does not prompt when closing a file tab that is alone in its pane", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));

    const proceed = await confirmTabClose("file-1");

    expect(proceed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirmPaneClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(confirm).mockResolvedValue(true);

    await confirmPaneClose("a");

    expect(confirm).toHaveBeenCalledWith("Close this pane? 1 terminal session will end.", {
      title: "gavin",
    });
  });

  it("confirmPageClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(confirm).mockResolvedValue(true);

    await confirmPageClose("ws-1", "page-1");

    expect(confirm).toHaveBeenCalledWith("Close this page? 1 terminal session will end.", {
      title: "gavin",
    });
  });

  it("confirmWorkspaceClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(confirm).mockResolvedValue(true);

    await confirmWorkspaceClose("ws-1");

    expect(confirm).toHaveBeenCalledWith("Close this workspace? 1 terminal session will end.", {
      title: "gavin",
    });
  });
});
