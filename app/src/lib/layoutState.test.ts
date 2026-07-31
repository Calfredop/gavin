import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import type { LayoutNode } from "./layout";

vi.mock("./backend", () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
  setLayout: vi.fn(),
  getCurrentLayout: vi.fn(),
  getBootstrapError: vi.fn(),
  writeInput: vi.fn(),
  resizeSession: vi.fn(),
  signalFrontendReady: vi.fn(),
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
} from "./layoutState";

function setState(partial: {
  tree: LayoutNode | null;
  focusedSessionId: string | null;
}): void {
  layoutState.update((s) => ({ ...s, status: "ready", ...partial }));
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutState.set({
    status: "connecting",
    errorMessage: "",
    tree: null,
    focusedSessionId: null,
    cwdBySessionId: {},
  });
});

describe("splitPane", () => {
  it("creates a session, splits the tree around the target, and persists", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await splitPane("a", "row");

    expect(backend.createSession).toHaveBeenCalledOnce();
    const state = get(layoutState);
    expect(state.tree).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
    expect(state.focusedSessionId).toBe("b");
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });

  it("surfaces an error and leaves the tree unchanged when create_session fails", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.createSession).mockRejectedValue(new Error("daemon unreachable"));

    await splitPane("a", "row");

    const state = get(layoutState);
    expect(state.tree).toEqual(tree);
    expect(state.status).toBe("error");
    expect(backend.setLayout).not.toHaveBeenCalled();
  });
});

describe("addTab", () => {
  it("creates a session, appends it as a new active tab, and persists", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await addTab("a");

    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 });
    expect(state.focusedSessionId).toBe("b");
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });
});

describe("closeSession", () => {
  it("kills the session then removes it from the tree", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "b" });
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("b");

    expect(backend.killSession).toHaveBeenCalledWith("b");
    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });

  it("does not remove the session from the tree when the daemon kill fails", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "b" });
    vi.mocked(backend.killSession).mockRejectedValue(new Error("no such session"));

    await closeSession("b");

    const state = get(layoutState);
    expect(state.tree).toEqual(tree);
    expect(state.status).toBe("error");
    expect(backend.setLayout).not.toHaveBeenCalled();
  });

  it("does not persist when closing the tree's very last session", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("a");

    const state = get(layoutState);
    expect(state.tree).toBeNull();
    expect(backend.setLayout).not.toHaveBeenCalled();
  });
});

describe("handleSessionExited", () => {
  it("removes the exited session without calling killSession", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "b" });

    handleSessionExited("b");

    expect(backend.killSession).not.toHaveBeenCalled();
    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("reassigns focus when the focused session is the one that exited", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    setState({ tree, focusedSessionId: "b" });

    handleSessionExited("b");

    const state = get(layoutState);
    expect(state.focusedSessionId).toBe("a");
  });

  it("leaves focus untouched when a background (non-focused) session exits", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "a" });

    handleSessionExited("b");

    const state = get(layoutState);
    expect(state.focusedSessionId).toBe("a");
  });

  it("is a no-op when called for a session already absent from the tree", () => {
    // Mirrors the daemon's own session-exited event arriving after
    // closeSession has already removed the session from the tree --
    // handleSessionExited must not throw (layout.closeTab throws for an
    // unknown session id) and must not mutate state or persist.
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });

    expect(() => handleSessionExited("already-gone")).not.toThrow();

    const state = get(layoutState);
    expect(state.tree).toEqual(tree);
    expect(state.focusedSessionId).toBe("a");
    expect(backend.setLayout).not.toHaveBeenCalled();
    expect(backend.killSession).not.toHaveBeenCalled();
  });
});

describe("handleCwdChanged", () => {
  it("records the cwd for a session", () => {
    layoutState.set({
      status: "ready",
      errorMessage: "",
      tree: null,
      focusedSessionId: null,
      cwdBySessionId: {},
    });
    handleCwdChanged("a", "/Users/alice/project");
    expect(get(layoutState).cwdBySessionId).toEqual({ a: "/Users/alice/project" });
  });

  it("updates an existing session's cwd without disturbing others", () => {
    layoutState.set({
      status: "ready",
      errorMessage: "",
      tree: null,
      focusedSessionId: null,
      cwdBySessionId: { a: "/old/path", b: "/other/path" },
    });
    handleCwdChanged("a", "/new/path");
    expect(get(layoutState).cwdBySessionId).toEqual({ a: "/new/path", b: "/other/path" });
  });
});

describe("closePane", () => {
  it("closes every tab in the pane, killing each session and dropping the whole pane", async () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 },
        { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
      ],
    };
    setState({ tree, focusedSessionId: "b" });
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePane("b");

    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.killSession).toHaveBeenCalledWith("b");
    expect(backend.killSession).not.toHaveBeenCalledWith("c");
    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["c"], activeTabIndex: 0 });
    expect(state.focusedSessionId).toBe("c");
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });

  it("does not throw and does not mutate state when the session id isn't found", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });

    await expect(closePane("missing")).resolves.toBeUndefined();

    const state = get(layoutState);
    expect(state.tree).toEqual(tree);
    expect(backend.killSession).not.toHaveBeenCalled();
    expect(backend.setLayout).not.toHaveBeenCalled();
  });
});

describe("switchToTab", () => {
  it("updates activeTabIndex and focus, and persists", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });

    await switchToTab("b");

    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 });
    expect(state.focusedSessionId).toBe("b");
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });
});

describe("focusPane", () => {
  it("updates focus without touching the tree or persisting", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: null });

    focusPane("a");

    const state = get(layoutState);
    expect(state.focusedSessionId).toBe("a");
    expect(state.tree).toEqual(tree);
    expect(backend.setLayout).not.toHaveBeenCalled();
  });
});
