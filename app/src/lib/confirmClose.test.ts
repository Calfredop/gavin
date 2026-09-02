import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LayoutNode } from "./layout";
import type { Page, Workspace } from "./workspace";

vi.mock("./dialog", () => ({
  askConfirm: vi.fn(),
}));

import { askConfirm } from "./dialog";
import { layoutState } from "./layoutState";
import {
  confirmTabClose,
  confirmTabsClose,
  confirmPaneClose,
  confirmPageClose,
  confirmWorkspaceClose,
} from "./confirmClose";

beforeEach(() => {
  vi.clearAllMocks();
});

// The whole prompt as one string -- heading, then the consequence lines
// under it -- so these assertions read the way the modal does.
function prompt(call = 0): string {
  const req = vi.mocked(askConfirm).mock.calls[call][0];
  return [req.title, ...(req.lines ?? [])].join(" ");
}

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

function ws(id: string, pages: Page[], activePageId: string | null = pages[0]?.id ?? null): Workspace {
  return { id, name: id, pages, activePageId };
}

// A workspace with "Close confirm" switched off in its settings.
function quietWs(id: string, pages: Page[]): Workspace {
  return { ...ws(id, pages), confirmTabClose: false };
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
    interruptedSessionIds: new Set(),
    orphanBySessionId: {},
    failureReasonById: {},
    fileTabsById: {},
    boardTabsById: {},
    removedWorkspaces: [],
  });
}

describe("confirmTabClose", () => {
  it("prompts even when the tab has siblings, naming the session it ends", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(true);
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(prompt()).toBe("Close this tab? The terminal session will end.");
    // The button says what it does; the OS dialog it replaced could only say OK.
    expect(vi.mocked(askConfirm).mock.calls[0][0].confirmLabel).toBe("Close tab");
  });

  it("prompts and returns the dialog's answer when the tab is the last one in its pane", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(true);
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(prompt()).toContain("last tab in this pane");
  });

  it("propagates a decline", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await confirmTabClose("a")).toBe(false);
  });

  it("finds the tab on a non-active page (sidebar session rows) and still prompts", async () => {
    setActivePage(
      [ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["lonely"]))], "page-1")],
      "ws-1"
    );
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await confirmTabClose("lonely")).toBe(false);
    expect(prompt()).toContain("last tab in this pane");
  });

  it("finds the tab in a non-active workspace too", async () => {
    setActivePage(
      [ws("ws-1", [page("page-1", leaf(["a", "b"]))]), ws("ws-2", [page("page-9", leaf(["solo"]))])],
      "ws-1"
    );
    vi.mocked(askConfirm).mockResolvedValue(true);
    expect(await confirmTabClose("solo")).toBe(true);
    expect(askConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("confirmPaneClose", () => {
  it("always prompts, even for a single-tab pane, and reports the session count", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b", "c"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(true);
    const result = await confirmPaneClose("b");
    expect(result).toBe(true);
    expect(prompt()).toContain("3 terminal sessions");
  });

  it("pluralizes correctly for a single session", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(true);
    await confirmPaneClose("a");
    expect(prompt()).toContain("1 terminal session ");
  });
});

describe("confirmPageClose", () => {
  it("always prompts and reports the page's session count", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(true);
    const result = await confirmPageClose("ws-1", "page-2");
    expect(result).toBe(true);
    expect(prompt()).toContain("1 terminal session ");
  });

  it("propagates a decline", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await confirmPageClose("ws-1", "page-1")).toBe(false);
  });
});

describe("confirmWorkspaceClose", () => {
  it("always prompts and reports the total session count across every page", async () => {
    setActivePage(
      [ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))])],
      "ws-1"
    );
    vi.mocked(askConfirm).mockResolvedValue(true);
    const result = await confirmWorkspaceClose("ws-1");
    expect(result).toBe(true);
    expect(prompt()).toContain("3 terminal sessions");
  });

  it("propagates a decline", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await confirmWorkspaceClose("ws-1")).toBe(false);
  });
});

describe("file tabs are not counted as terminal sessions", () => {
  it("confirmTabClose prompts for a file tab without claiming a session ends", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    const proceed = await confirmTabClose("file-1");

    expect(proceed).toBe(true);
    expect(prompt()).toBe("Close this tab?");
  });

  it("confirmPaneClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    await confirmPaneClose("a");

    expect(prompt()).toBe("Close this pane? 1 terminal session will end.");
  });

  it("confirmPaneClose excludes board tabs from the count too", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1", "board-1"]))])], "ws-1");
    layoutState.update((s) => ({
      ...s,
      fileTabsById: { "file-1": { path: "/tmp/a.md" } },
      boardTabsById: { "board-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" } },
    }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    await confirmPaneClose("a");

    expect(prompt()).toBe("Close this pane? 1 terminal session will end.");
  });

  it("confirmTabClose still warns about the pane for a board tab alone in it", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["board-1"]))])], "ws-1");
    layoutState.update((s) => ({
      ...s,
      boardTabsById: { "board-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" } },
    }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    const proceed = await confirmTabClose("board-1");

    expect(proceed).toBe(true);
    expect(prompt()).toContain("last tab in this pane");
  });

  it("confirmPageClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    await confirmPageClose("ws-1", "page-1");

    expect(prompt()).toBe("Close this page? 1 terminal session will end.");
  });

  it("confirmWorkspaceClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    await confirmWorkspaceClose("ws-1");

    expect(prompt()).toContain("1 terminal session will end");
    // Says what it does not do: the X is app-side only.
    expect(prompt()).toContain("Nothing on disk is deleted");
  });
});

describe("the Close confirm setting", () => {
  it("is on when the workspace has never set it", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(true);
    await confirmTabClose("a");
    expect(askConfirm).toHaveBeenCalledTimes(1);
  });

  it("suppresses the prompt entirely when off -- including the pane-emptying case", async () => {
    setActivePage([quietWs("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    expect(await confirmTabClose("a")).toBe(true);
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("reads the setting off the workspace that owns the tab, not the visible one", async () => {
    // The sidebar can close a tab in a workspace that isn't on screen;
    // taking the active workspace's setting would apply the wrong one.
    setActivePage(
      [ws("ws-1", [page("page-1", leaf(["a"]))]), quietWs("ws-2", [page("page-9", leaf(["solo"]))])],
      "ws-1"
    );
    expect(await confirmTabClose("solo")).toBe(true);
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("falls back to the active workspace for a tab in no page tree (the main agent)", async () => {
    setActivePage([quietWs("ws-1", [page("page-1", leaf(["a"]))])], "ws-1");
    expect(await confirmTabClose("main-agent")).toBe(true);
    expect(askConfirm).not.toHaveBeenCalled();
  });
});

describe("confirmTabsClose", () => {
  it("asks once for the whole batch and counts the sessions it ends", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    expect(await confirmTabsClose(["a", "b", "file-1"])).toBe(true);
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(prompt()).toBe("Close 3 tabs? 2 terminal sessions will end.");
    expect(vi.mocked(askConfirm).mock.calls[0][0].confirmLabel).toBe("Close tabs");
  });

  it("omits the session sentence when the batch is all file and board tabs", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1", "file-2"]))])], "ws-1");
    layoutState.update((s) => ({
      ...s,
      fileTabsById: { "file-1": { path: "/tmp/a.md" }, "file-2": { path: "/tmp/b.md" } },
    }));
    vi.mocked(askConfirm).mockResolvedValue(true);

    await confirmTabsClose(["file-1", "file-2"]);
    expect(prompt()).toBe("Close 2 tabs?");
  });

  it("delegates a single tab to the single-tab wording", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(true);
    await confirmTabsClose(["a"]);
    expect(prompt()).toBe("Close this tab? The terminal session will end.");
    // The button says what it does; the OS dialog it replaced could only say OK.
    expect(vi.mocked(askConfirm).mock.calls[0][0].confirmLabel).toBe("Close tab");
  });

  it("propagates a decline for the batch", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "b", "c"]))])], "ws-1");
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await confirmTabsClose(["a", "b"])).toBe(false);
  });

  it("stays silent for an empty batch and when the setting is off", async () => {
    setActivePage([quietWs("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1");
    expect(await confirmTabsClose([])).toBe(true);
    expect(await confirmTabsClose(["a", "b"])).toBe(true);
    expect(askConfirm).not.toHaveBeenCalled();
  });
});
