import { describe, expect, it } from "vitest";
import {
  backToWorkspaces,
  initialView,
  loadView,
  openWorkspace,
  placeFiles,
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
    expect(initialView()).toEqual({ workspaceId: null, surface: "board" });
  });

  it("opens a workspace on its board, and goes back to the list", () => {
    const opened = openWorkspace(initialView(), "w1");
    expect(opened).toEqual({ workspaceId: "w1", surface: "board" });
    expect(backToWorkspaces(opened)).toEqual({ workspaceId: null, surface: "board" });
  });

  it("falls back to the list when the workspace it remembered is gone from the Workstation", () => {
    const remembered = openWorkspace(initialView(), "w1");
    expect(reconcileView(remembered, ["w2", "w3"])).toEqual(initialView());
    expect(reconcileView(remembered, ["w1", "w2"])).toBe(remembered);
    expect(reconcileView(initialView(), [])).toEqual(initialView());
  });
});

describe("a workspace's surfaces", () => {
  it("are the board, Git, Files and Settings, each with its name on the strip", () => {
    expect(SURFACES).toEqual(["board", "git", "files", "settings"]);
    expect(SURFACES.map((s) => SURFACE_LABELS[s])).toEqual(["Board", "Git", "Files", "Settings"]);
  });

  it("switch within the open workspace, keeping where Files was", () => {
    const inFiles = placeFiles(showSurface(openWorkspace(initialView(), "w1"), "files"), {
      dir: "/w1/src",
      file: "/w1/src/a.ts",
    });
    expect(showSurface(inFiles, "git")).toEqual({
      workspaceId: "w1",
      surface: "git",
      files: { dir: "/w1/src", file: "/w1/src/a.ts" },
    });
  });

  it("are nothing to switch at the workspace list", () => {
    expect(showSurface(initialView(), "git")).toEqual(initialView());
    expect(placeFiles(initialView(), { dir: "/x", file: null })).toEqual(initialView());
  });

  it("start again on the board, and Files at nowhere, in another workspace", () => {
    const inFiles = placeFiles(showSurface(openWorkspace(initialView(), "w1"), "files"), {
      dir: "/w1/src",
      file: null,
    });
    expect(openWorkspace(inFiles, "w2")).toEqual({ workspaceId: "w2", surface: "board" });
    expect(backToWorkspaces(inFiles)).toEqual(initialView());
    expect(reconcileView(inFiles, ["w2"])).toEqual(initialView());
  });
});

describe("the Workstation's own screens", () => {
  it("open from the workspace list, and go back to it", () => {
    const settings = showScreen(initialView(), "settings");
    expect(settings).toEqual({ workspaceId: null, surface: "board", screen: "settings" });
    expect(showScreen(settings, "add-workspace")).toEqual({
      workspaceId: null,
      surface: "board",
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
    expect(openWorkspace(showScreen(initialView(), "settings"), "w1")).toEqual({ workspaceId: "w1", surface: "board" });
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
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "files" });
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
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "board" });
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
      [viewKey("demo")]: JSON.stringify({ workspaceId: "w1", surface: "holodeck" }),
    });
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "board" });
  });

  it("comes back to the Workstation's settings, but never half-way through adding a workspace", () => {
    const storage = memoryStorage();
    saveView(storage, "demo", showScreen(initialView(), "settings"));
    expect(loadView(storage, "demo")).toEqual({ workspaceId: null, surface: "board", screen: "settings" });
    saveView(storage, "demo", showScreen(initialView(), "add-workspace"));
    expect(loadView(storage, "demo")).toEqual(initialView());
  });

  it("forgets a screen stored with a workspace open", () => {
    const storage = memoryStorage({
      [viewKey("demo")]: JSON.stringify({ workspaceId: "w1", surface: "git", screen: "settings" }),
    });
    expect(loadView(storage, "demo")).toEqual({ workspaceId: "w1", surface: "git" });
  });

  it("works, remembering nothing, where the Device gives the page no storage", () => {
    expect(loadView(BROKEN, "demo")).toEqual(initialView());
    expect(() => saveView(BROKEN, "demo", initialView())).not.toThrow();
    expect(loadView(null, "demo")).toEqual(initialView());
    expect(() => saveView(null, "demo", initialView())).not.toThrow();
  });
});
