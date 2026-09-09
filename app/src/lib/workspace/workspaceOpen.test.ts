import { describe, expect, it, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const picker = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => picker);

const backendMock = vi.hoisted(() => ({
  gavinRootExists: vi.fn(async () => false),
  initGavinRoot: vi.fn(async () => {}),
  setGavinGitTracking: vi.fn(async () => ({
    isRepo: true,
    tracked: false,
    ignoredBy: ".gitignore:1:.gavin-root/",
    gavinManaged: true,
    indexed: 0,
  })),
}));
vi.mock("$lib/backend", () => backendMock);

const dialogMock = vi.hoisted(() => ({ showAlert: vi.fn(async () => {}) }));
vi.mock("$lib/dialog", () => dialogMock);

const layoutMock = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  setWorkspaceRoot: vi.fn(async () => {}),
  switchWorkspace: vi.fn(async () => {}),
  markGitTrackingAsked: vi.fn(async () => {}),
}));

vi.mock("$lib/layoutState", async () => {
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
    markGitTrackingAsked: layoutMock.markGitTrackingAsked,
  };
});

import { layoutState } from "$lib/layoutState";
import {
  bindWithoutInit,
  cancelOpen,
  initAndOpen,
  nameForRoot,
  openWorkspaceFolder,
  pendingOpen,
  workspaceForRoot,
} from "$lib/workspace/workspaceOpen";

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
  // Reset the resolutions too, not just the call log: clearAllMocks
  // leaves a mockRejectedValue from a previous test in place, and a
  // scaffold that silently keeps failing turns every later assertion
  // into a test of the error path.
  backendMock.initGavinRoot.mockResolvedValue(undefined);
  backendMock.setGavinGitTracking.mockResolvedValue({
    isRepo: true,
    tracked: false,
    ignoredBy: ".gitignore:1:.gavin-root/",
    gavinManaged: true,
    indexed: 0,
  });
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

    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" }, true);
    expect(order).toEqual(["init", "create"]);
    expect(backendMock.initGavinRoot).toHaveBeenCalledWith("/repo/fresh", "fresh");
    expect(layoutMock.setWorkspaceRoot).toHaveBeenCalledWith("ws-fresh", "/repo/fresh");
  });

  // A folder that could not be scaffolded must not silently become a
  // workspace on a root gavin never wrote to.
  it("reports a failed init and creates nothing", async () => {
    backendMock.initGavinRoot.mockRejectedValue(new Error("read-only"));
    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" }, true);
    expect(dialogMock.showAlert).toHaveBeenCalled();
    expect(layoutMock.createWorkspace).not.toHaveBeenCalled();
    expect(get(pendingOpen)).toBeNull();
  });

  // "Tracked" is what a repo with no rule already does, so an "on" has
  // nothing to write -- and writing one anyway would put a .gitignore into
  // every folder anybody ever initialised.
  it("writes no ignore rule when the box was left ticked", async () => {
    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" }, true);
    expect(backendMock.setGavinGitTracking).not.toHaveBeenCalled();
  });

  it("writes the ignore rule when the box was cleared, and never touches the index", async () => {
    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" }, false);
    // Third argument false: init has just created these files, so there
    // is nothing in the index to remove and nothing to ask about.
    expect(backendMock.setGavinGitTracking).toHaveBeenCalledWith("/repo/fresh", false, false);
  });

  // The workspace is scaffolded and about to open; a .gitignore that
  // could not be written is a line in Settings away from being fixed.
  it("still opens the workspace when the ignore rule cannot be written", async () => {
    backendMock.setGavinGitTracking.mockRejectedValueOnce(new Error("read-only"));
    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" }, false);
    expect(dialogMock.showAlert).not.toHaveBeenCalled();
    expect(layoutMock.setWorkspaceRoot).toHaveBeenCalledWith("ws-fresh", "/repo/fresh");
  });

  // The prompt PUT the git question, so the wizard's git step must not
  // put it again -- and it can only be recorded once the workspace the
  // record hangs on exists.
  it("records that the git question was answered, on the workspace it just made", async () => {
    await initAndOpen({ rootPath: "/repo/fresh", name: "fresh" }, true);
    expect(layoutMock.markGitTrackingAsked).toHaveBeenCalledWith("ws-fresh");
  });

  // Nothing was asked, so nothing has been answered: binding an existing
  // folder must leave the wizard's step to do its job.
  it("records nothing when the folder is opened without initializing", async () => {
    await bindWithoutInit({ rootPath: "/repo/plain", name: "plain" });
    expect(layoutMock.markGitTrackingAsked).not.toHaveBeenCalled();
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
