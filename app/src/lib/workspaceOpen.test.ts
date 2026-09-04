import { describe, expect, it, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const picker = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => picker);

const backendMock = vi.hoisted(() => ({
  gavinRootExists: vi.fn(async () => false),
  initGavinRoot: vi.fn(async () => {}),
}));
vi.mock("./backend", () => backendMock);

const dialogMock = vi.hoisted(() => ({ showAlert: vi.fn(async () => {}) }));
vi.mock("./dialog", () => dialogMock);

const layoutMock = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  setWorkspaceRoot: vi.fn(async () => {}),
  switchWorkspace: vi.fn(async () => {}),
}));

vi.mock("./layoutState", async () => {
  const { writable } = await import("svelte/store");
  const layoutState = writable({
    workspaces: [] as { id: string; name: string; rootPath?: string }[],
    activeWorkspaceId: null as string | null,
  });
  return {
    layoutState,
    // Mirrors the real one closely enough for these tests: it mints a
    // workspace and makes it active, and reports the id only by leaving
    // it in the store.
    createWorkspace: layoutMock.createWorkspace.mockImplementation(async (name: string) => {
      const id = `ws-${name}`;
      layoutState.update((s) => ({
        workspaces: [...s.workspaces, { id, name }],
        activeWorkspaceId: id,
      }));
    }) as unknown,
    setWorkspaceRoot: layoutMock.setWorkspaceRoot,
    switchWorkspace: layoutMock.switchWorkspace,
  };
});

import { layoutState } from "./layoutState";
import {
  bindWithoutInit,
  cancelOpen,
  initAndOpen,
  nameForRoot,
  openWorkspaceFolder,
  pendingOpen,
  workspaceForRoot,
} from "./workspaceOpen";

/// Only the two fields this module reads. LayoutState has sixteen more,
/// and listing them would make every fixture here about the store rather
/// than about opening a folder.
function setState(
  workspaces: { id: string; name: string; rootPath?: string }[],
  activeWorkspaceId: string | null = null
): void {
  layoutState.set({ workspaces, activeWorkspaceId } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.gavinRootExists.mockResolvedValue(false);
  pendingOpen.set(null);
  setState([]);
});

describe("naming a folder", () => {
  it("takes the folder's own basename, trailing slash or not", () => {
    expect(nameForRoot("/Users/me/code/gavin")).toBe("gavin");
    expect(nameForRoot("/Users/me/code/gavin/")).toBe("gavin");
  });
});

describe("finding the workspace already on a folder", () => {
  it("matches on the path, ignoring a trailing separator", () => {
    const state = {
      workspaces: [
        { id: "a", name: "a", rootPath: "/one" },
        { id: "b", name: "b", rootPath: "/two/" },
      ],
      activeWorkspaceId: null,
    };
    expect(workspaceForRoot(state as never, "/one/")).toBe("a");
    expect(workspaceForRoot(state as never, "/two")).toBe("b");
    expect(workspaceForRoot(state as never, "/three")).toBeNull();
  });

  it("ignores a workspace with no folder at all", () => {
    const state = { workspaces: [{ id: "a", name: "a" }], activeWorkspaceId: null };
    expect(workspaceForRoot(state as never, "")).toBeNull();
  });
});

describe("opening a folder", () => {
  it("does nothing when the picker is cancelled", async () => {
    picker.open.mockResolvedValue(null);
    await openWorkspaceFolder();
    expect(layoutMock.createWorkspace).not.toHaveBeenCalled();
    expect(get(pendingOpen)).toBeNull();
  });

  // Two workspaces on one root would each watch it and each fetch its
  // board; the second is never what "open this folder" meant.
  it("switches to the workspace already on that folder", async () => {
    setState([{ id: "here", name: "here", rootPath: "/repo" }]);
    picker.open.mockResolvedValue("/repo");
    await openWorkspaceFolder();
    expect(layoutMock.switchWorkspace).toHaveBeenCalledWith("here");
    expect(layoutMock.createWorkspace).not.toHaveBeenCalled();
  });

  it("binds straight away when gavin already lives there", async () => {
    picker.open.mockResolvedValue("/repo/gavin");
    backendMock.gavinRootExists.mockResolvedValue(true);
    await openWorkspaceFolder();
    expect(layoutMock.createWorkspace).toHaveBeenCalledWith("gavin");
    expect(layoutMock.setWorkspaceRoot).toHaveBeenCalledWith("ws-gavin", "/repo/gavin");
    expect(get(pendingOpen)).toBeNull();
  });

  // Nothing is created until the answer is known: an "Open" that made a
  // workspace and THEN asked would leave a rootless row behind on every
  // cancel, which is the state the sidebar's + used to produce.
  it("asks before scaffolding, and creates nothing while it asks", async () => {
    picker.open.mockResolvedValue("/repo/fresh");
    await openWorkspaceFolder();
    expect(get(pendingOpen)).toEqual({ rootPath: "/repo/fresh", name: "fresh" });
    expect(layoutMock.createWorkspace).not.toHaveBeenCalled();

    cancelOpen();
    expect(get(pendingOpen)).toBeNull();
    expect(layoutMock.createWorkspace).not.toHaveBeenCalled();
  });
});

describe("answering the initialize question", () => {
  it("scaffolds before the workspace exists, then binds", async () => {
    const order: string[] = [];
    backendMock.initGavinRoot.mockImplementation(async () => void order.push("init"));
    layoutMock.createWorkspace.mockImplementation(async (name: string) => {
      order.push("create");
      setState([{ id: `ws-${name}`, name }], `ws-${name}`);
    });

    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" });
    expect(order).toEqual(["init", "create"]);
    expect(backendMock.initGavinRoot).toHaveBeenCalledWith("/repo/fresh", "fresh");
    expect(layoutMock.setWorkspaceRoot).toHaveBeenCalledWith("ws-fresh", "/repo/fresh");
  });

  // A folder that could not be scaffolded must not silently become a
  // workspace on a root gavin never wrote to.
  it("reports a failed init and creates nothing", async () => {
    backendMock.initGavinRoot.mockRejectedValue(new Error("read-only"));
    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" });
    expect(dialogMock.showAlert).toHaveBeenCalled();
    expect(layoutMock.createWorkspace).not.toHaveBeenCalled();
    expect(get(pendingOpen)).toBeNull();
  });

  // A repo can be a workspace for its terminals and its git tab long
  // before anyone wants a board in it.
  it("opens without scaffolding when asked to", async () => {
    await bindWithoutInit({ rootPath: "/repo/plain", name: "plain" });
    expect(backendMock.initGavinRoot).not.toHaveBeenCalled();
    expect(layoutMock.createWorkspace).toHaveBeenCalledWith("plain");
    expect(layoutMock.setWorkspaceRoot).toHaveBeenCalledWith("ws-plain", "/repo/plain");
  });
});
