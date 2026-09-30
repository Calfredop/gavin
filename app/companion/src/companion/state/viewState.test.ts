import { describe, expect, it } from "vitest";
import {
  backToWorkspaces,
  closeTerminal,
  initialView,
  loadView,
  openTerminal,
  openWorkspace,
  reconcileSession,
  reconcileView,
  saveView,
  showSurface,
  viewKey,
  type ViewStorage,
} from "$companion/state/viewState";

function memoryStorage(seed: Record<string, string> = {}): ViewStorage & { items: Record<string, string> } {
  const items = { ...seed };
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => void (items[key] = value),
  };
}

const BROKEN: ViewStorage = {
  getItem: () => {
    throw new Error("storage is unavailable");
  },
  setItem: () => {
    throw new Error("storage is full");
  },
};

describe("where the Companion is looking", () => {
  it("starts at the workspace list", () => {
    expect(initialView()).toEqual({ workspaceId: null, surface: "board", sessionId: null });
  });

  it("opens a workspace on its board, and goes back to the list", () => {
    const opened = openWorkspace(initialView(), "w1");
    expect(opened).toEqual({ workspaceId: "w1", surface: "board", sessionId: null });
    expect(backToWorkspaces(opened)).toEqual({ workspaceId: null, surface: "board", sessionId: null });
  });

  it("opens the next workspace on the surface the human last chose", () => {
    const sessions = showSurface(openWorkspace(initialView(), "w1"), "sessions");
    const next = openWorkspace(backToWorkspaces(sessions), "w2");
    expect(next).toEqual({ workspaceId: "w2", surface: "sessions", sessionId: null });
  });

  it("opens a terminal over its workspace's sessions, and closes it back to them", () => {
    const board = openWorkspace(initialView(), "w1");
    const terminal = openTerminal("w1", "s1");
    expect(terminal).toEqual({ workspaceId: "w1", surface: "sessions", sessionId: "s1" });
    expect(closeTerminal(terminal)).toEqual({ workspaceId: "w1", surface: "sessions", sessionId: null });
    // Going elsewhere closes it: a surface, the list, another workspace.
    expect(showSurface(terminal, "board").sessionId).toBeNull();
    expect(backToWorkspaces(terminal).sessionId).toBeNull();
    expect(openWorkspace(terminal, "w2").sessionId).toBeNull();
    expect(board.sessionId).toBeNull();
  });

  it("falls back to the list when the workspace it remembered is gone from the Workstation", () => {
    const remembered = openWorkspace(initialView(), "w1");
    expect(reconcileView(remembered, ["w2", "w3"])).toEqual(initialView());
    expect(reconcileView(remembered, ["w1", "w2"])).toBe(remembered);
    expect(reconcileView(initialView(), [])).toEqual(initialView());
  });

  it("closes a terminal whose session has ended, back to the sessions", () => {
    const terminal = openTerminal("w1", "s1");
    expect(reconcileSession(terminal, ["s2"])).toEqual(closeTerminal(terminal));
    expect(reconcileSession(terminal, ["s1", "s2"])).toBe(terminal);
    const list = closeTerminal(terminal);
    expect(reconcileSession(list, [])).toBe(list);
  });
});

describe("remembering it on the Device", () => {
  it("is kept per Workstation", () => {
    expect(viewKey("demo")).toBe("gavin.companion.view.demo");
    expect(viewKey("mac-studio")).not.toBe(viewKey("demo"));
  });

  it("comes back as it was saved", () => {
    const storage = memoryStorage();
    saveView(storage, "demo", openWorkspace(initialView(), "w1"));
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "board", sessionId: null });
    saveView(storage, "demo", openTerminal("w1", "s1"));
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "sessions", sessionId: "s1" });
  });

  it("reads a view a bundle older than terminals saved", () => {
    const storage = memoryStorage({ [viewKey("demo")]: JSON.stringify({ workspaceId: "w1", surface: "board" }) });
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "board", sessionId: null });
  });

  it("opens no terminal where there is no workspace to hold it", () => {
    const storage = memoryStorage({
      [viewKey("demo")]: JSON.stringify({ workspaceId: null, surface: "sessions", sessionId: "s1" }),
    });
    expect(loadView(storage, "demo").sessionId).toBeNull();
  });

  it("does not leak from one Workstation to another", () => {
    const storage = memoryStorage();
    saveView(storage, "mac-studio", openWorkspace(initialView(), "w1"));
    expect(loadView(storage, "demo")).toEqual(initialView());
  });

  it.each([
    ["nothing stored", undefined],
    ["not JSON", "{{{"],
    ["not an object", "[1,2]"],
    ["null", "null"],
    ["a workspace id that is not a string", JSON.stringify({ workspaceId: 7, surface: "board" })],
  ])("starts at the list when what is stored is %s", (_name, stored) => {
    const storage = memoryStorage(stored === undefined ? {} : { [viewKey("demo")]: stored });
    expect(loadView(storage, "demo")).toEqual(initialView());
  });

  it("opens the board for a surface a newer bundle saved and this one does not have", () => {
    const storage = memoryStorage({
      [viewKey("demo")]: JSON.stringify({ workspaceId: "w1", surface: "holodeck", sessionId: "s1" }),
    });
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "board", sessionId: null });
  });

  it("works, remembering nothing, where the Device gives the page no storage", () => {
    expect(loadView(BROKEN, "demo")).toEqual(initialView());
    expect(() => saveView(BROKEN, "demo", initialView())).not.toThrow();
    expect(loadView(null, "demo")).toEqual(initialView());
    expect(() => saveView(null, "demo", initialView())).not.toThrow();
  });
});
