import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";

// The three things this flow does to the app: mint a workspace, read
// back which one became active, and open the wizard on it. Mocked so the
// handoff itself stays testable without the store graph behind
// layoutState.
vi.mock("$lib/core/layoutState", () => ({
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  openWizard: vi.fn(),
  // Built inside the factory: vi.mock is hoisted above every top-level
  // binding in this file, so a store declared out here would not exist
  // yet when the factory runs.
  layoutState: writable<{ activeWorkspaceId: string | null }>({ activeWorkspaceId: null }),
}));

import {
  newWorkspaceFlow,
  startCreatingWorkspace,
  setNewWorkspaceName,
  cancelNewWorkspace,
  commitNewWorkspace,
  skipSetup,
  finishSetup,
} from "$lib/workspace/workspaceCreate";
import { createWorkspace, openWizard, layoutState } from "$lib/core/layoutState";

const layoutStateMock = layoutState as ReturnType<typeof writable<{ activeWorkspaceId: string | null }>>;

beforeEach(() => {
  newWorkspaceFlow.set({ naming: null, pendingSetupId: null });
  layoutStateMock.set({ activeWorkspaceId: null });
  vi.mocked(createWorkspace).mockClear();
  vi.mocked(openWizard).mockClear();
});

describe("naming", () => {
  it("starts with no naming box and no modal", () => {
    expect(get(newWorkspaceFlow)).toEqual({ naming: null, pendingSetupId: null });
  });

  it("opens an empty naming box on the surface that asked", () => {
    startCreatingWorkspace("hub");
    expect(get(newWorkspaceFlow).naming).toEqual({ surface: "hub", name: "" });
  });

  it("moves the box to the other surface rather than opening a second one", () => {
    startCreatingWorkspace("sidebar");
    setNewWorkspaceName("half typed");
    startCreatingWorkspace("hub");
    expect(get(newWorkspaceFlow).naming).toEqual({ surface: "hub", name: "" });
  });

  it("opens empty again after an abandoned run rather than restoring the old text", () => {
    startCreatingWorkspace("sidebar");
    setNewWorkspaceName("half typed");
    cancelNewWorkspace();
    startCreatingWorkspace("sidebar");
    expect(get(newWorkspaceFlow).naming?.name).toBe("");
  });

  it("ignores a name change while no naming is in progress", () => {
    setNewWorkspaceName("stray");
    expect(get(newWorkspaceFlow).naming).toBeNull();
  });

  it("cancelling creates nothing", async () => {
    startCreatingWorkspace("sidebar");
    setNewWorkspaceName("Project");
    cancelNewWorkspace();
    await commitNewWorkspace();
    expect(createWorkspace).not.toHaveBeenCalled();
  });
});

describe("commitNewWorkspace", () => {
  it("creates the workspace under the trimmed name and puts its setup modal up", async () => {
    layoutStateMock.set({ activeWorkspaceId: "ws-new" });
    startCreatingWorkspace("sidebar");
    setNewWorkspaceName("  Project  ");
    await commitNewWorkspace();
    expect(createWorkspace).toHaveBeenCalledWith("Project");
    expect(get(newWorkspaceFlow)).toEqual({ naming: null, pendingSetupId: "ws-new" });
  });

  it("treats a blank name as a dismissal, not a nameless workspace", async () => {
    startCreatingWorkspace("sidebar");
    setNewWorkspaceName("   ");
    await commitNewWorkspace();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(get(newWorkspaceFlow)).toEqual({ naming: null, pendingSetupId: null });
  });

  it("is a no-op when no naming is in progress", async () => {
    await commitNewWorkspace();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("closes the naming box before awaiting, so a second Enter cannot create a second workspace", async () => {
    layoutStateMock.set({ activeWorkspaceId: "ws-new" });
    let release: () => void = () => {};
    vi.mocked(createWorkspace).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve()))
    );
    startCreatingWorkspace("sidebar");
    setNewWorkspaceName("Project");
    const inFlight = commitNewWorkspace();
    expect(get(newWorkspaceFlow).naming).toBeNull();
    // The second Enter, arriving while the first is still in flight.
    await commitNewWorkspace();
    release();
    await inFlight;
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("setup handoff", () => {
  it("skipping closes the modal and never opens the wizard", () => {
    newWorkspaceFlow.set({ naming: null, pendingSetupId: "ws-new" });
    skipSetup();
    expect(get(newWorkspaceFlow).pendingSetupId).toBeNull();
    expect(openWizard).not.toHaveBeenCalled();
  });

  it("finishing closes the modal and opens the wizard on the same workspace", () => {
    newWorkspaceFlow.set({ naming: null, pendingSetupId: "ws-new" });
    finishSetup();
    expect(get(newWorkspaceFlow).pendingSetupId).toBeNull();
    expect(openWizard).toHaveBeenCalledWith("ws-new");
  });

  it("finishing with no modal up opens no wizard", () => {
    finishSetup();
    expect(openWizard).not.toHaveBeenCalled();
  });
});
