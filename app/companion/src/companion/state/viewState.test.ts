import { describe, expect, it } from "vitest";
import {
  backToWorkspaces,
  initialView,
  loadView,
  openWorkspace,
  reconcileView,
  saveView,
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

describe("remembering it on the Device", () => {
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

  it("works, remembering nothing, where the Device gives the page no storage", () => {
    expect(loadView(BROKEN, "demo")).toEqual(initialView());
    expect(() => saveView(BROKEN, "demo", initialView())).not.toThrow();
    expect(loadView(null, "demo")).toEqual(initialView());
    expect(() => saveView(null, "demo", initialView())).not.toThrow();
  });
});
