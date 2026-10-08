import { describe, expect, it } from "vitest";
import {
  backToWorkspaces,
  closePage,
  closeTerminal,
  initialView,
  loadView,
  openPage,
  openTerminal,
  openWorkspace,
  placeFiles,
  reconcileSession,
  reconcileView,
  saveView,
  showScreen,
  showSurface,
  SURFACE_LABELS,
  SURFACES,
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

describe("a page over a board", () => {
  const CARD = { kind: "card" as const, path: "/r/.gavin-root/plans/a.md" };

  it("opens a card, or the PRD, over the board, and closes back to it", () => {
    const sessions = showSurface(openWorkspace(initialView(), "ws-1"), "sessions");
    const card = openPage(sessions, CARD);
    expect(card).toEqual({ workspaceId: "ws-1", surface: "board", sessionId: null, page: CARD });
    expect(closePage(card).page).toBeUndefined();
    expect(openPage(card, { kind: "prd" }).page).toEqual({ kind: "prd" });
  });

  it("opens a card over the Decisions or Review list it was picked from, and closes back to that list", () => {
    for (const surface of ["decisions", "review"] as const) {
      const card = openPage(showSurface(openWorkspace(initialView(), "ws-1"), surface), CARD);
      expect(card).toEqual({ workspaceId: "ws-1", surface, sessionId: null, page: CARD });
      expect(closePage(card)).toEqual({ workspaceId: "ws-1", surface, sessionId: null, page: undefined });
    }
  });

  it("is closed by going anywhere else", () => {
    const card = openPage(openWorkspace(initialView(), "ws-1"), CARD);
    expect(showSurface(card, "sessions").page).toBeUndefined();
    expect(openWorkspace(card, "ws-2").page).toBeUndefined();
    expect(backToWorkspaces(card).page).toBeUndefined();
    expect(openTerminal("ws-1", "s-1").page).toBeUndefined();
  });

  it("is remembered on the Device, and one this bundle cannot open is dropped for the board", () => {
    const storage = memoryStorage();
    const card = openPage(openWorkspace(initialView(), "ws-1"), CARD);
    saveView(storage, "w", card);
    expect(loadView(storage, "w")).toEqual(card);

    const stored = (page: unknown) =>
      memoryStorage({ [viewKey("w")]: JSON.stringify({ workspaceId: "ws-1", surface: "board", sessionId: null, page }) });
    expect(loadView(stored({ kind: "rails" }), "w")).toEqual({ workspaceId: "ws-1", surface: "board", sessionId: null });
    expect(loadView(stored({ kind: "card", path: 3 }), "w").page).toBeUndefined();
    expect(loadView(stored({ kind: "prd" }), "w").page).toEqual({ kind: "prd" });
  });

  it("is only ever over a workspace's board, or its Decisions or Review list", () => {
    const stored = (view: object) => memoryStorage({ [viewKey("w")]: JSON.stringify({ ...view, page: { kind: "prd" } }) });
    expect(loadView(stored({ workspaceId: null, surface: "board", sessionId: null }), "w").page).toBeUndefined();
    expect(loadView(stored({ workspaceId: "ws-1", surface: "sessions", sessionId: null }), "w").page).toBeUndefined();
    expect(loadView(stored({ workspaceId: "ws-1", surface: "review", sessionId: null }), "w").page).toEqual({ kind: "prd" });
  });
});

describe("a workspace's surfaces", () => {
  it("are the board, rails, sessions, Decisions, Review, Git, Files and Settings, each with its name on the strip", () => {
    expect(SURFACES).toEqual(["board", "rails", "sessions", "decisions", "review", "git", "files", "settings"]);
    expect(SURFACES.map((s) => SURFACE_LABELS[s])).toEqual([
      "Board",
      "Rails",
      "Sessions",
      "Decisions",
      "Review",
      "Git",
      "Files",
      "Settings",
    ]);
  });

  it("switch within the open workspace, keeping where Files was", () => {
    const inFiles = placeFiles(showSurface(openWorkspace(initialView(), "w1"), "files"), {
      dir: "/w1/src",
      file: "/w1/src/a.ts",
    });
    expect(showSurface(inFiles, "git")).toEqual({
      workspaceId: "w1",
      surface: "git",
      sessionId: null,
      files: { dir: "/w1/src", file: "/w1/src/a.ts" },
    });
  });

  it("are nothing to switch at the workspace list", () => {
    expect(showSurface(initialView(), "git")).toEqual(initialView());
    expect(placeFiles(initialView(), { dir: "/x", file: null })).toEqual(initialView());
  });

  it("start Files at nowhere in another workspace, on the surface last chosen", () => {
    const inFiles = placeFiles(showSurface(openWorkspace(initialView(), "w1"), "files"), {
      dir: "/w1/src",
      file: null,
    });
    const list = { workspaceId: null, surface: "files", sessionId: null };
    expect(openWorkspace(inFiles, "w2")).toEqual({ workspaceId: "w2", surface: "files", sessionId: null });
    expect(backToWorkspaces(inFiles)).toEqual(list);
    expect(reconcileView(inFiles, ["w2"])).toEqual(list);
  });
});

describe("the Workstation's own screens", () => {
  it("open from the workspace list, and go back to it", () => {
    const settings = showScreen(initialView(), "settings");
    expect(settings).toEqual({ workspaceId: null, surface: "board", sessionId: null, screen: "settings" });
    expect(showScreen(settings, "add-workspace")).toEqual({
      workspaceId: null,
      surface: "board",
      sessionId: null,
      screen: "add-workspace",
    });
    expect(showScreen(settings, "workspaces")).toEqual(initialView());
    expect(backToWorkspaces(settings)).toEqual(initialView());
  });

  it("are not reached from inside an open workspace", () => {
    const open = openWorkspace(initialView(), "w1");
    expect(showScreen(open, "settings")).toBe(open);
  });

  it("are left behind when a workspace opens", () => {
    expect(openWorkspace(showScreen(initialView(), "settings"), "w1")).toEqual({
      workspaceId: "w1",
      surface: "board",
      sessionId: null,
    });
  });
});

describe("remembering it on the Device", () => {
  it("keeps the surface and where Files was", () => {
    const storage = memoryStorage();
    const view = placeFiles(showSurface(openWorkspace(initialView(), "w1"), "files"), {
      dir: "/w1/docs",
      file: "/w1/docs/guide.md",
    });
    saveView(storage, "demo", view);
    expect(loadView(storage, "demo")).toEqual(view);
  });

  it.each([
    ["not an object", 7],
    ["a folder that is not a string", { dir: 3, file: null }],
    ["a file that is neither a path nor null", { dir: "/w1", file: 3 }],
  ])("forgets a Files place that is %s, and keeps the rest", (_name, files) => {
    const storage = memoryStorage({
      [viewKey("demo")]: JSON.stringify({ workspaceId: "w1", surface: "files", files }),
    });
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "files", sessionId: null });
  });

  it("forgets a Files place stored with no workspace open", () => {
    const storage = memoryStorage({
      [viewKey("demo")]: JSON.stringify({ workspaceId: null, surface: "board", files: { dir: "/x", file: null } }),
    });
    expect(loadView(storage, "demo")).toEqual(initialView());
  });

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

  it("comes back to the Workstation's settings, but never half-way through adding a workspace", () => {
    const storage = memoryStorage();
    saveView(storage, "demo", showScreen(initialView(), "settings"));
    expect(loadView(storage, "demo")).toEqual({ workspaceId: null, surface: "board", sessionId: null, screen: "settings" });
    saveView(storage, "demo", showScreen(initialView(), "add-workspace"));
    expect(loadView(storage, "demo")).toEqual(initialView());
  });

  it("forgets a screen stored with a workspace open", () => {
    const storage = memoryStorage({
      [viewKey("demo")]: JSON.stringify({ workspaceId: "w1", surface: "git", screen: "settings" }),
    });
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "git", sessionId: null });
  });

  it("works, remembering nothing, where the Device gives the page no storage", () => {
    expect(loadView(BROKEN, "demo")).toEqual(initialView());
    expect(() => saveView(BROKEN, "demo", initialView())).not.toThrow();
    expect(loadView(null, "demo")).toEqual(initialView());
    expect(() => saveView(null, "demo", initialView())).not.toThrow();
  });
});
