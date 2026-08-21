import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Writable } from "svelte/store";
import type { LayoutNode } from "./layout";

// The store is created INSIDE the factory: vi.mock is hoisted above the
// imports and this factory runs while keyboard.ts is being imported, so
// anything it closes over from module scope would still be uninitialized.
// The test reads the store back from the mocked module instead.
vi.mock("./layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    layoutState: writable<Record<string, unknown>>({}),
    splitPane: vi.fn().mockResolvedValue(undefined),
    addTab: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    switchToTab: vi.fn().mockResolvedValue(undefined),
    switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
    switchPage: vi.fn().mockResolvedValue(undefined),
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("./clipboard", () => ({
  copySelection: vi.fn().mockResolvedValue(undefined),
  pasteClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./confirmClose", () => ({ confirmTabClose: vi.fn().mockResolvedValue(true) }));
vi.mock("./platform", () => ({
  isMacSync: () => true,
  cmdHeld: (e: KeyboardEvent) => e.metaKey,
}));

import {
  layoutState,
  switchToTab,
  switchWorkspaceView,
  switchPage,
  switchWorkspace,
  addTab,
} from "./layoutState";
import { handleShortcutKeydown, type ShortcutKeyEvent } from "./keyboard";

const state = layoutState as unknown as Writable<Record<string, unknown>>;

const leaf = (tabs: string[]): LayoutNode => ({ type: "leaf", tabs, activeTabIndex: 0 });

function setState(over: Record<string, unknown> = {}): void {
  state.set({
    status: "ready",
    workspaces: [
      {
        id: "ws-1",
        name: "ws-1",
        rootPath: "/r",
        activeView: "terminal",
        activePageId: "p1",
        pages: [
          { id: "p1", name: "p1", layout: leaf(["a", "b", "c"]), focusedSessionId: "a" },
          { id: "p2", name: "p2", layout: leaf(["d"]), focusedSessionId: "d" },
        ],
      },
      { id: "__unfiled__", name: "Unfiled", pages: [], activePageId: null },
    ],
    activeWorkspaceId: "ws-1",
    focusedSessionId: "a",
    fileTabsById: {},
    boardTabsById: {},
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setState();
});

function event(over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: "",
    code: "",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  };
}

/// Presses a digit with ⌘ held and returns whether it was handled.
function press(code: string, over: Partial<ShortcutKeyEvent> = {}): Promise<boolean> {
  return handleShortcutKeydown(event({ code, ...over }));
}

describe("digit navigation", () => {
  it("⌘2 switches to the second tab of the focused pane", async () => {
    expect(await press("Digit2")).toBe(true);
    expect(switchToTab).toHaveBeenCalledWith("b");
  });

  it("⌘9 goes to the last tab and ⌘0 to the first", async () => {
    await press("Digit9");
    expect(switchToTab).toHaveBeenCalledWith("c");
    await press("Digit0");
    expect(switchToTab).toHaveBeenCalledWith("a");
  });

  it("does nothing when the position is past the end", async () => {
    expect(await press("Digit7")).toBe(false);
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it("switches hub tabs when a hub view is active", async () => {
    setState({
      workspaces: [
        { id: "ws-1", name: "ws-1", rootPath: "/r", activeView: "kanban", activePageId: null, pages: [] },
      ],
      focusedSessionId: null,
    });
    await press("Digit2");
    // home, git, kanban, ... -> the second visible view is git
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "git");
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it("⌘⇧2 switches page", async () => {
    await press("Digit2", { shiftKey: true });
    expect(switchPage).toHaveBeenCalledWith("ws-1", "p2");
  });

  it("⌘⌥2 switches workspace in sidebar order (Unfiled first)", async () => {
    await press("Digit2", { altKey: true });
    expect(switchWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("⌘⌥1 selects Unfiled, which the sidebar pins to the top", async () => {
    await press("Digit1", { altKey: true });
    expect(switchWorkspace).toHaveBeenCalledWith("__unfiled__");
  });

  it("ignores the digit without the command key", async () => {
    expect(await press("Digit2", { metaKey: false })).toBe(false);
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it("ignores a digit with both shift and alt", async () => {
    expect(await press("Digit2", { shiftKey: true, altKey: true })).toBe(false);
    expect(switchPage).not.toHaveBeenCalled();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });
});

describe("letter shortcuts", () => {
  it("still requires a focused session", async () => {
    setState({ focusedSessionId: null });
    await handleShortcutKeydown(event({ key: "t", code: "KeyT" }));
    expect(addTab).not.toHaveBeenCalled();
  });

  it("⌘T adds a tab when one is focused", async () => {
    expect(await handleShortcutKeydown(event({ key: "t", code: "KeyT" }))).toBe(true);
    expect(addTab).toHaveBeenCalledWith("a");
  });
});
