import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const layoutMock = vi.hoisted(() => ({
  switchWorkspace: vi.fn(async () => {}),
  openAppHub: vi.fn(),
}));

vi.mock("./layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    layoutState: writable({
      workspaces: [] as { id: string }[],
      activeWorkspaceId: null as string | null,
    }),
    switchWorkspace: layoutMock.switchWorkspace,
    openAppHub: layoutMock.openAppHub,
  };
});

import {
  SIDEBAR_COLLAPSED_KEY,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  setSidebarCollapsed,
  sidebarCollapsed,
  toggleSidebarCollapsed,
  SCRATCHPAD_KEY,
  loadScratchpadEnabled,
  saveScratchpadEnabled,
  scratchpadEnabled,
  setScratchpadEnabled,
} from "./sidebarPrefs";
import { layoutState } from "./layoutState";
import { UNFILED_WORKSPACE_ID } from "./workspace";

/// The two fields this module reads, cast in: LayoutState has sixteen
/// more, and spelling them out would make the fixture about the store
/// rather than about the preference under test.
function state(workspaceIds: string[], activeWorkspaceId: string | null): void {
  layoutState.set({
    workspaces: workspaceIds.map((id) => ({ id })),
    activeWorkspaceId,
  } as never);
}

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("remembering that the sidebar is collapsed", () => {
  it("round-trips through storage", () => {
    const store = storage();
    saveSidebarCollapsed(true, store);
    expect(store.map.get(SIDEBAR_COLLAPSED_KEY)).toBe("true");
    expect(loadSidebarCollapsed(store)).toBe(true);

    saveSidebarCollapsed(false, store);
    expect(loadSidebarCollapsed(store)).toBe(false);
  });

  // Expanded is the state that shows every affordance, so it is the one
  // to fall back to when the answer cannot be read.
  it("reads anything it did not write as expanded", () => {
    expect(loadSidebarCollapsed(storage())).toBe(false);
    expect(loadSidebarCollapsed(storage({ [SIDEBAR_COLLAPSED_KEY]: "yes" }))).toBe(false);
    expect(loadSidebarCollapsed(storage({ [SIDEBAR_COLLAPSED_KEY]: "" }))).toBe(false);
    expect(loadSidebarCollapsed(undefined)).toBe(false);
  });

  it("survives a storage that throws", () => {
    const hostile = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(loadSidebarCollapsed(hostile)).toBe(false);
    expect(() => saveSidebarCollapsed(true, hostile)).not.toThrow();
  });
});

describe("the collapsed store", () => {
  it("toggles and sets", () => {
    setSidebarCollapsed(false);
    expect(get(sidebarCollapsed)).toBe(false);
    toggleSidebarCollapsed();
    expect(get(sidebarCollapsed)).toBe(true);
    toggleSidebarCollapsed();
    expect(get(sidebarCollapsed)).toBe(false);
    setSidebarCollapsed(true);
    expect(get(sidebarCollapsed)).toBe(true);
    setSidebarCollapsed(false);
  });
});

describe("remembering that the Scratchpad is switched off", () => {
  it("round-trips through storage", () => {
    const store = storage();
    saveScratchpadEnabled(false, store);
    expect(store.map.get(SCRATCHPAD_KEY)).toBe("false");
    expect(loadScratchpadEnabled(store)).toBe(false);
    saveScratchpadEnabled(true, store);
    expect(loadScratchpadEnabled(store)).toBe(true);
  });

  // Shown is the default and hidden is the choice, so anything unreadable
  // has to come back as shown -- forgetting a preference must not also
  // lose a way to reach the pages inside it.
  it("reads anything it did not write as shown", () => {
    expect(loadScratchpadEnabled(storage())).toBe(true);
    expect(loadScratchpadEnabled(storage({ [SCRATCHPAD_KEY]: "off" }))).toBe(true);
    expect(loadScratchpadEnabled(undefined)).toBe(true);
    expect(
      loadScratchpadEnabled({
        getItem() {
          throw new Error("blocked");
        },
        setItem() {},
      })
    ).toBe(true);
  });
});

describe("switching the Scratchpad off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state([], null);
    scratchpadEnabled.set(true);
  });

  it("leaves you where you are when you are not standing in it", async () => {
    state([UNFILED_WORKSPACE_ID, "w1"], "w1");
    await setScratchpadEnabled(false);
    expect(get(scratchpadEnabled)).toBe(false);
    expect(layoutMock.switchWorkspace).not.toHaveBeenCalled();
    expect(layoutMock.openAppHub).not.toHaveBeenCalled();
  });

  // Otherwise the app is left showing a workspace with no row anywhere
  // and no shortcut to it.
  it("moves off it first when you are", async () => {
    state([UNFILED_WORKSPACE_ID, "w1"], UNFILED_WORKSPACE_ID);
    await setScratchpadEnabled(false);
    expect(layoutMock.switchWorkspace).toHaveBeenCalledWith("w1");
  });

  it("falls back to the app hub when there is nowhere else to go", async () => {
    state([UNFILED_WORKSPACE_ID], UNFILED_WORKSPACE_ID);
    await setScratchpadEnabled(false);
    expect(layoutMock.switchWorkspace).not.toHaveBeenCalled();
    expect(layoutMock.openAppHub).toHaveBeenCalled();
  });

  it("switching it back on moves nobody", async () => {
    state([UNFILED_WORKSPACE_ID], UNFILED_WORKSPACE_ID);
    await setScratchpadEnabled(true);
    expect(get(scratchpadEnabled)).toBe(true);
    expect(layoutMock.switchWorkspace).not.toHaveBeenCalled();
    expect(layoutMock.openAppHub).not.toHaveBeenCalled();
  });
});
