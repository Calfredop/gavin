import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import type { Writable } from "svelte/store";
import type { LayoutNode } from "$lib/panes/layout";

// The store is created INSIDE the factory: vi.mock is hoisted above the
// imports and this factory runs while keyboard.ts is being imported, so
// anything it closes over from module scope would still be uninitialized.
// The test reads the store back from the mocked module instead.
vi.mock("$lib/layoutState", async () => {
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
vi.mock("$lib/clipboard", () => ({
  copySelection: vi.fn().mockResolvedValue(undefined),
  pasteClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/shell/confirmClose", () => ({ confirmTabClose: vi.fn().mockResolvedValue(true) }));
// Switchable per test via globalThis, which the hoisted factory can read
// without closing over module scope (that would be uninitialized here).
vi.mock("$lib/platform", () => {
  const mac = () => (globalThis as Record<string, unknown>).__testIsMac !== false;
  return {
    isMacSync: mac,
    cmdHeld: (e: KeyboardEvent) => (mac() ? e.metaKey : e.ctrlKey),
  };
});

import {
  layoutState,
  switchToTab,
  switchWorkspaceView,
  switchPage,
  switchWorkspace,
  addTab,
  closeSession,
  splitPane,
} from "$lib/layoutState";
import { copySelection, pasteClipboard } from "$lib/clipboard";
import { handleShortcutKeydown, type ShortcutKeyEvent } from "$lib/keyboard";
import { requestedCompose } from "$lib/cards/composeRequest";
import {
  hubTabOrderByWorkspace,
  hubTabsHiddenByWorkspace,
  hubTabsHiddenDefault,
} from "$lib/hub/hubTabPrefs";

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
      { id: "__unfiled__", name: "Scratchpad", pages: [], activePageId: null },
    ],
    activeWorkspaceId: "ws-1",
    focusedSessionId: "a",
    fileTabsById: {},
    boardTabsById: {},
    ...over,
  });
}

/// The same two pages as setState, but with a HUB tab as the active
/// view -- the state a workspace is in the moment ⌘T is pressed on the
/// Kanban/Git/PRD screen, with focusedSessionId still pointing at the
/// pane the terminal detour left behind.
function hubWorkspace(view: string): unknown[] {
  return [
    {
      id: "ws-1",
      name: "ws-1",
      rootPath: "/r",
      activeView: view,
      activePageId: "p1",
      pages: [
        { id: "p1", name: "p1", layout: leaf(["a", "b", "c"]), focusedSessionId: "a" },
        { id: "p2", name: "p2", layout: leaf(["d"]), focusedSessionId: "d" },
      ],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as Record<string, unknown>).__testIsMac = true;
  requestedCompose.set(null);
  hubTabsHiddenDefault.set([]);
  hubTabsHiddenByWorkspace.set({});
  hubTabOrderByWorkspace.set({});
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

/// A stand-in for the element a key landed on. These tests run with no
/// DOM, and the shortcut layer duck-types its target for exactly that
/// reason, so a plain object is enough.
function domTarget(props: {
  tagName: string;
  isContentEditable?: boolean;
  inTerminal?: boolean;
}): EventTarget {
  return {
    tagName: props.tagName,
    isContentEditable: props.isContentEditable ?? false,
    closest: (selector: string) => (props.inTerminal && selector === ".xterm" ? {} : null),
  } as unknown as EventTarget;
}

/// The node xterm focuses for keyboard input: a <textarea> living inside
/// the terminal's own container.
function xtermTextarea(): EventTarget {
  return domTarget({ tagName: "TEXTAREA", inTerminal: true });
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

  // The digits address tabs BY POSITION, so they have to count the row
  // the human is looking at -- not the one gavin declares.
  it("counts the hub tabs the human hid", async () => {
    setState({
      workspaces: [
        { id: "ws-1", name: "ws-1", rootPath: "/r", activeView: "kanban", activePageId: null, pages: [] },
      ],
      focusedSessionId: null,
    });
    hubTabsHiddenDefault.set(["git"]);
    await press("Digit2");
    // home, kanban, ... -> git is gone, so the second tab is now Kanban.
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "kanban");
  });

  it("counts the hub tabs in the order they were dragged into", async () => {
    setState({
      workspaces: [
        { id: "ws-1", name: "ws-1", rootPath: "/r", activeView: "kanban", activePageId: null, pages: [] },
      ],
      focusedSessionId: null,
    });
    hubTabOrderByWorkspace.set({ "ws-1": ["plans", "kanban"] });
    await press("Digit2");
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "kanban");
  });

  it("lets a workspace's own hidden list beat the app-wide one", async () => {
    setState({
      workspaces: [
        { id: "ws-1", name: "ws-1", rootPath: "/r", activeView: "kanban", activePageId: null, pages: [] },
      ],
      focusedSessionId: null,
    });
    hubTabsHiddenDefault.set(["git"]);
    hubTabsHiddenByWorkspace.set({ "ws-1": [] });
    await press("Digit2");
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "git");
  });

  it("⌘⇧2 switches page", async () => {
    await press("Digit2", { shiftKey: true });
    expect(switchPage).toHaveBeenCalledWith("ws-1", "p2");
  });

  // The digits count the rows the sidebar DRAWS, and a pinned page is
  // drawn first -- so ⌘⇧1 has to be that page, not whatever sits first
  // in the stored array. Both readers go through sidebarPageOrder for
  // exactly this reason.
  it("⌘⇧1 follows the sidebar's pinned page order", async () => {
    setState({
      workspaces: [
        {
          id: "ws-1",
          name: "ws-1",
          activeView: "terminal",
          activePageId: "p1",
          pages: [
            { id: "p1", name: "p1", layout: leaf(["a"]), focusedSessionId: "a" },
            { id: "p2", name: "p2", layout: leaf(["d"]), focusedSessionId: "d", pinnedAt: 10 },
          ],
        },
      ],
    });
    await press("Digit1", { shiftKey: true });
    expect(switchPage).toHaveBeenCalledWith("ws-1", "p2");
  });

  it("⌘⌥1 follows the sidebar's pinned workspace order", async () => {
    setState({
      workspaces: [
        { id: "ws-1", name: "ws-1", activeView: "terminal", activePageId: null, pages: [] },
        { id: "ws-2", name: "ws-2", activeView: "terminal", activePageId: null, pages: [], pinnedAt: 10 },
      ],
    });
    await press("Digit1", { altKey: true });
    expect(switchWorkspace).toHaveBeenCalledWith("ws-2");
  });

  it("⌘⌥2 switches workspace in sidebar order (Scratchpad first)", async () => {
    await press("Digit2", { altKey: true });
    expect(switchWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("⌘⌥1 selects the Scratchpad, which the sidebar pins to the top", async () => {
    await press("Digit1", { altKey: true });
    expect(switchWorkspace).toHaveBeenCalledWith("__unfiled__");
  });

  it("ignores the digit without the command key", async () => {
    expect(await press("Digit2", { metaKey: false })).toBe(false);
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it("consumes the event BEFORE awaiting the action", async () => {
    // Regression guard: preventDefault() after an await lands a task turn
    // too late and the terminal has already seen the key.
    let preventedBeforeAction: boolean | null = null;
    const e = event({ code: "Digit2" });
    vi.mocked(switchToTab).mockImplementationOnce(async () => {
      preventedBeforeAction = vi.mocked(e.preventDefault).mock.calls.length > 0;
    });
    await handleShortcutKeydown(e);
    expect(preventedBeforeAction).toBe(true);
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("leaves an unhandled digit alone for the terminal", async () => {
    const e = event({ code: "Digit7" });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it("ignores ⌃⌘1 on macOS -- the other command key must be up", async () => {
    expect(await press("Digit1", { ctrlKey: true })).toBe(false);
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it("on Windows/Linux, ignores AltGr+digit (ctrl+alt) so layouts can still type ² @ ~", async () => {
    (globalThis as Record<string, unknown>).__testIsMac = false;
    const e = event({ code: "Digit2", metaKey: false, ctrlKey: true, altKey: true });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(switchWorkspace).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("on Windows/Linux, Ctrl+2 still switches tabs", async () => {
    (globalThis as Record<string, unknown>).__testIsMac = false;
    await handleShortcutKeydown(event({ code: "Digit2", metaKey: false, ctrlKey: true }));
    expect(switchToTab).toHaveBeenCalledWith("b");
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

  it("⌘T does nothing while a hub tab is on screen", async () => {
    setState({ workspaces: hubWorkspace("kanban") });
    const e = event({ key: "t", code: "KeyT" });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(addTab).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("⌘T does nothing when the focused session is not on the active page", async () => {
    setState({ focusedSessionId: "d" });
    expect(await handleShortcutKeydown(event({ key: "t", code: "KeyT" }))).toBe(false);
    expect(addTab).not.toHaveBeenCalled();
  });

  it("⌘W and ⌘D refuse off the terminal view too", async () => {
    setState({ workspaces: hubWorkspace("git") });
    expect(await handleShortcutKeydown(event({ key: "w", code: "KeyW" }))).toBe(false);
    expect(await handleShortcutKeydown(event({ key: "d", code: "KeyD" }))).toBe(false);
    expect(closeSession).not.toHaveBeenCalled();
    expect(splitPane).not.toHaveBeenCalled();
  });
});

describe("clipboard shortcuts", () => {
  const paste = (over: Partial<ShortcutKeyEvent> = {}) =>
    event({ key: "v", code: "KeyV", ...over });
  const copy = (over: Partial<ShortcutKeyEvent> = {}) =>
    event({ key: "c", code: "KeyC", ...over });

  it("⌘V still reaches the focused terminal", async () => {
    const e = paste();
    expect(await handleShortcutKeydown(e)).toBe(true);
    expect(pasteClipboard).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("⌘V in xterm's hidden textarea is the terminal's, not the field's", async () => {
    const e = paste({ target: xtermTextarea() });
    expect(await handleShortcutKeydown(e)).toBe(true);
    expect(pasteClipboard).toHaveBeenCalled();
  });

  it("leaves ⌘V alone in an <input> so the field pastes natively", async () => {
    const e = paste({ target: domTarget({ tagName: "INPUT" }) });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(pasteClipboard).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it("leaves ⌘V alone in a <textarea>", async () => {
    const e = paste({ target: domTarget({ tagName: "TEXTAREA" }) });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(pasteClipboard).not.toHaveBeenCalled();
  });

  it("leaves ⌘V alone in a contenteditable (the plan editor)", async () => {
    const e = paste({ target: domTarget({ tagName: "DIV", isContentEditable: true }) });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(pasteClipboard).not.toHaveBeenCalled();
  });

  it("⌘V over ordinary chrome still goes to the terminal", async () => {
    const e = paste({ target: domTarget({ tagName: "DIV" }) });
    expect(await handleShortcutKeydown(e)).toBe(true);
    expect(pasteClipboard).toHaveBeenCalled();
  });

  it("leaves ⌘C alone in a text field so the field copies its own selection", async () => {
    const e = copy({ target: domTarget({ tagName: "INPUT" }) });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(copySelection).not.toHaveBeenCalled();
  });

  it("⌘C in the terminal still copies the terminal selection", async () => {
    const e = copy({ target: xtermTextarea() });
    expect(await handleShortcutKeydown(e)).toBe(true);
    expect(copySelection).toHaveBeenCalled();
  });

  it("⌘V from a hub tab never reaches a background page's terminal", async () => {
    setState({ workspaces: hubWorkspace("prd") });
    const e = paste({ target: domTarget({ tagName: "DIV" }) });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(pasteClipboard).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("⌘C from a hub tab leaves the page's own selection to the browser", async () => {
    setState({ workspaces: hubWorkspace("prd") });
    const e = copy({ target: domTarget({ tagName: "DIV" }) });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(copySelection).not.toHaveBeenCalled();
  });
});

describe("⌘N — new card", () => {
  it("asks the hub board for a composer when the Kanban tab is active", async () => {
    setState({ workspaces: [{ id: "ws-1", name: "ws-1", pages: [], activePageId: null, activeView: "kanban" }] });
    expect(await handleShortcutKeydown(event({ key: "n" }))).toBe(true);
    expect(get(requestedCompose)).toEqual({ kind: "hub", workspaceId: "ws-1" });
  });

  it("asks the focused board TAB when one is focused in the terminal view", async () => {
    setState({ boardTabsById: { a: { workspaceId: "ws-1", contextFolder: "/r/.gavin" } } });
    expect(await handleShortcutKeydown(event({ key: "n" }))).toBe(true);
    expect(get(requestedCompose)).toEqual({ kind: "tab", workspaceId: "ws-1", tabId: "a" });
  });

  it("leaves ⌘N to the terminal when no board is on screen", async () => {
    const e = event({ key: "n" });
    expect(await handleShortcutKeydown(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(get(requestedCompose)).toBeNull();
  });

  it("is not ⇧⌘N or ⌥⌘N", async () => {
    setState({ workspaces: [{ id: "ws-1", name: "ws-1", pages: [], activePageId: null, activeView: "kanban" }] });
    expect(await handleShortcutKeydown(event({ key: "n", shiftKey: true }))).toBe(false);
    expect(await handleShortcutKeydown(event({ key: "n", altKey: true }))).toBe(false);
    expect(get(requestedCompose)).toBeNull();
  });

  it("consumes the key so the terminal never sees it", async () => {
    setState({ workspaces: [{ id: "ws-1", name: "ws-1", pages: [], activePageId: null, activeView: "kanban" }] });
    const e = event({ key: "n" });
    await handleShortcutKeydown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("fires with no focused session at all -- a board needs no terminal", async () => {
    setState({
      workspaces: [{ id: "ws-1", name: "ws-1", pages: [], activePageId: null, activeView: "kanban" }],
      focusedSessionId: null,
    });
    expect(await handleShortcutKeydown(event({ key: "n" }))).toBe(true);
  });

  it("on Windows/Linux it is Ctrl+N", async () => {
    (globalThis as Record<string, unknown>).__testIsMac = false;
    setState({ workspaces: [{ id: "ws-1", name: "ws-1", pages: [], activePageId: null, activeView: "kanban" }] });
    expect(await handleShortcutKeydown(event({ key: "n", metaKey: false, ctrlKey: true }))).toBe(true);
    expect(get(requestedCompose)).toEqual({ kind: "hub", workspaceId: "ws-1" });
  });
});
