import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const layout = vi.hoisted(() => {
  function store<T>(initial: T) {
    let value = initial;
    const subscribers = new Set<(v: T) => void>();
    return {
      subscribe(run: (v: T) => void) {
        subscribers.add(run);
        run(value);
        return () => void subscribers.delete(run);
      },
      set(next: T) {
        value = next;
        for (const run of [...subscribers]) run(value);
      },
      update(fn: (v: T) => T) {
        const next = fn(value);
        value = next;
        for (const run of [...subscribers]) run(value);
      },
    };
  }
  const layoutState = store({
    workspaces: [] as Array<{
      id: string;
      rootPath?: string | null;
      fallbackChains?: Record<string, string[]>;
      armedAgents?: string[];
      declinedAgents?: string[];
    }>,
    activeWorkspaceId: null as string | null,
  });
  const agentDefaultsStore = store({
    customCommand: "",
    customModelFlag: "",
    complexityTables: {} as Record<string, Record<string, { profile: string; model: string }>>,
    fallbackChains: {},
  });
  const wizardWorkspaceId = store<string | null>(null);
  const newWorkspaceFlow = store({ naming: null, pendingSetupId: null as string | null });
  return {
    layoutState,
    wizardWorkspaceId,
    newWorkspaceFlow,
    agentDefaultsStore,
    resolvedAgentFor: vi.fn(() => ({ profileId: "claude-code" })),
    workspaceComplexityTable: vi.fn(() => ({})),
    markAgentArmed: vi.fn(async (workspaceId: string, profileId: string) => {
      layoutState.update((s) => ({
        ...s,
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId
            ? { ...w, armedAgents: [...(w.armedAgents ?? []), profileId] }
            : w
        ),
      }));
    }),
    setAgentArmDeclined: vi.fn(
      async (workspaceId: string, profileId: string, declined: boolean) => {
        layoutState.update((s) => ({
          ...s,
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const rest = (w.declinedAgents ?? []).filter((id) => id !== profileId);
            return { ...w, declinedAgents: declined ? [...rest, profileId] : rest };
          }),
        }));
      }
    ),
  };
});

vi.mock("$lib/core/layoutState", () => layout);
vi.mock("$lib/workspace/workspaceCreate", () => ({ newWorkspaceFlow: layout.newWorkspaceFlow }));

import {
  armNewlyAdded,
  armRequest,
  askAgainToArm,
  completeArmRequest,
  declineArmRequest,
  dismissArmRequest,
  holdArming,
  owedArming,
  requestArm,
  startArmOnFocus,
} from "$lib/agents/agentFallbackState";

beforeEach(() => {
  armRequest.set(null);
  layout.layoutState.set({
    workspaces: [
      { id: "w1", rootPath: "/repo/w1" },
      { id: "w-dismiss", rootPath: "/repo/w-dismiss" },
    ],
    activeWorkspaceId: null,
  });
  layout.wizardWorkspaceId.set(null);
  layout.newWorkspaceFlow.set({ naming: null, pendingSetupId: null });
  layout.agentDefaultsStore.set({
    customCommand: "",
    customModelFlag: "",
    complexityTables: {},
    fallbackChains: {},
  });
  layout.resolvedAgentFor.mockReturnValue({ profileId: "claude-code" });
  layout.workspaceComplexityTable.mockReturnValue({});
});

describe("owedArming", () => {
  it("names unarmed chain and complexity profiles, not the workspace agent", () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", rootPath: "/repo/w1", fallbackChains: { "claude-code": ["codex"] }, armedAgents: [] }],
      activeWorkspaceId: "w1",
    });
    layout.agentDefaultsStore.set({
      customCommand: "",
      customModelFlag: "",
      complexityTables: { "claude-code": { intricate: { profile: "gemini", model: "" } } },
      fallbackChains: {},
    });
    // The effective table of the agent this workspace runs: the one place
    // a card's attributed profile comes from.
    layout.workspaceComplexityTable.mockReturnValue({ intricate: { profile: "gemini", model: "" } });
    expect(owedArming("w1")).toEqual(["codex", "gemini"]);
    expect(layout.workspaceComplexityTable).toHaveBeenCalledWith("w1", "claude-code");
  });

  it("asks for the table of whichever agent the workspace runs", () => {
    layout.layoutState.set({ workspaces: [{ id: "w1", rootPath: "/repo/w1", armedAgents: [] }], activeWorkspaceId: "w1" });
    layout.resolvedAgentFor.mockReturnValue({ profileId: "codex" });
    layout.workspaceComplexityTable.mockReturnValue({ trivial: { profile: "opencode", model: "" } });
    expect(owedArming("w1")).toEqual(["opencode"]);
    expect(layout.workspaceComplexityTable).toHaveBeenCalledWith("w1", "codex");
  });

  it("leaves out an agent the human said not to ask about again", () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", rootPath: "/repo/w1", fallbackChains: { "claude-code": ["codex", "gemini"] }, declinedAgents: ["codex"] }],
      activeWorkspaceId: "w1",
    });
    expect(owedArming("w1")).toEqual(["gemini"]);
  });

  it("unions every primary's effective chain, not only the workspace agent's", () => {
    layout.layoutState.set({
      workspaces: [
        { id: "w1", rootPath: "/repo/w1", fallbackChains: { "claude-code": ["codex"], gemini: ["opencode"] }, armedAgents: [] },
      ],
      activeWorkspaceId: "w1",
    });
    expect(owedArming("w1")).toEqual(["codex", "opencode"]);
  });

  it("treats a workspace's empty chain for a primary as no fallback for it", () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", rootPath: "/repo/w1", fallbackChains: { "claude-code": [] }, armedAgents: [] }],
      activeWorkspaceId: "w1",
    });
    layout.agentDefaultsStore.set({
      customCommand: "",
      customModelFlag: "",
      complexityTables: {},
      fallbackChains: { "claude-code": ["codex"] },
    });
    expect(owedArming("w1")).toEqual([]);
  });
});

describe("armNewlyAdded", () => {
  it("opens the wizard only for ids that just appeared", () => {
    armNewlyAdded("w1", ["codex"], ["codex", "gemini"]);
    expect(get(armRequest)).toEqual({ workspaceId: "w1", profileId: "gemini" });
  });

  it("does nothing for a reorder", () => {
    armNewlyAdded("w1", ["codex", "gemini"], ["gemini", "codex"]);
    expect(get(armRequest)).toBeNull();
  });

  it("asks again about an agent the human explicitly put back in the chain", async () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", rootPath: "/repo/w1", fallbackChains: { "claude-code": ["gemini"] }, declinedAgents: ["gemini"] }],
      activeWorkspaceId: "w1",
    });
    await armNewlyAdded("w1", [], ["gemini"]);
    expect(layout.setAgentArmDeclined).toHaveBeenCalledWith("w1", "gemini", false);
    expect(get(armRequest)).toEqual({ workspaceId: "w1", profileId: "gemini" });
  });
});

describe("requestArm", () => {
  it("does not reopen a profile the human dismissed this session", () => {
    requestArm("w-dismiss", "codex");
    dismissArmRequest();
    requestArm("w-dismiss", "codex");
    expect(get(armRequest)).toBeNull();
  });
});

describe("declineArmRequest", () => {
  it("records the choice so no later focus or launch reopens the wizard", async () => {
    layout.layoutState.set({
      workspaces: [{ id: "w-decline", rootPath: "/repo/w-decline", fallbackChains: { "claude-code": ["codex"] } }],
      activeWorkspaceId: null,
    });
    requestArm("w-decline", "codex");
    await declineArmRequest();
    expect(get(armRequest)).toBeNull();
    expect(layout.setAgentArmDeclined).toHaveBeenCalledWith("w-decline", "codex", true);
    expect(owedArming("w-decline")).toEqual([]);
    requestArm("w-decline", "codex");
    expect(get(armRequest)).toBeNull();
  });
});

describe("askAgainToArm", () => {
  it("drops the recorded choice and opens the wizard", async () => {
    layout.layoutState.set({
      workspaces: [{ id: "w-again", rootPath: "/repo/w-again", fallbackChains: { "claude-code": ["codex"] } }],
      activeWorkspaceId: null,
    });
    requestArm("w-again", "codex");
    await declineArmRequest();
    await askAgainToArm("w-again", "codex");
    expect(layout.setAgentArmDeclined).toHaveBeenLastCalledWith("w-again", "codex", false);
    expect(get(armRequest)).toEqual({ workspaceId: "w-again", profileId: "codex" });
  });
});

describe("completeArmRequest", () => {
  it("records the arm and queues the next owed profile", async () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", rootPath: "/repo/w1", fallbackChains: { "claude-code": ["codex", "gemini"] }, armedAgents: [] }],
      activeWorkspaceId: "w1",
    });
    requestArm("w1", "codex");
    await completeArmRequest();
    expect(layout.markAgentArmed).toHaveBeenCalledWith("w1", "codex");
    expect(get(armRequest)).toEqual({ workspaceId: "w1", profileId: "gemini" });
  });
});

describe("startArmOnFocus", () => {
  it("queues the first owed agent when the active workspace changes", () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", rootPath: "/repo/w1", fallbackChains: { "claude-code": ["codex"] }, armedAgents: [] }],
      activeWorkspaceId: null,
    });
    const stop = startArmOnFocus();
    layout.layoutState.update((s) => ({ ...s, activeWorkspaceId: "w1" }));
    expect(get(armRequest)).toEqual({ workspaceId: "w1", profileId: "codex" });
    stop();
  });
});

// The fallback wizard is a follow-up to a workspace's own setup. Created
// from the hub, a workspace becomes active before its creation modal is
// up, gets its root inside that modal, and only then reaches the setup
// wizard -- and the fallback wizard used to pop out at the first of those.
describe("arming waits for the workspace's own setup", () => {
  const chain = { "claude-code": ["codex"] };

  it("does not ask in a workspace with no root yet", () => {
    layout.layoutState.set({ workspaces: [{ id: "w-new", fallbackChains: chain }], activeWorkspaceId: null });
    const stop = startArmOnFocus();
    layout.layoutState.update((s) => ({ ...s, activeWorkspaceId: "w-new" }));
    expect(get(armRequest)).toBeNull();
    requestArm("w-new", "codex");
    expect(get(armRequest)).toBeNull();
    stop();
  });

  it("asks only once the setup wizard closes, through the whole creation flow", () => {
    layout.layoutState.set({ workspaces: [], activeWorkspaceId: null });
    const stop = startArmOnFocus();
    // createWorkspace: a rootless workspace, made active.
    layout.layoutState.set({ workspaces: [{ id: "w-new", fallbackChains: chain }], activeWorkspaceId: "w-new" });
    // commitNewWorkspace puts the creation modal up; the folder is picked in it.
    layout.newWorkspaceFlow.set({ naming: null, pendingSetupId: "w-new" });
    layout.layoutState.update((s) => ({
      ...s,
      workspaces: s.workspaces.map((w) => ({ ...w, rootPath: "/repo/w-new" })),
    }));
    expect(get(armRequest)).toBeNull();
    // finishSetup: wizard open, then the modal closed.
    layout.wizardWorkspaceId.set("w-new");
    layout.newWorkspaceFlow.set({ naming: null, pendingSetupId: null });
    expect(get(armRequest)).toBeNull();
    // A launch that needs an arm while the wizard is up waits as well.
    requestArm("w-new", "codex");
    expect(get(armRequest)).toBeNull();
    // closeWizard.
    layout.wizardWorkspaceId.set(null);
    expect(get(armRequest)).toEqual({ workspaceId: "w-new", profileId: "codex" });
    stop();
  });

  it("asks when a skipped setup's workspace later gets a root", () => {
    layout.layoutState.set({ workspaces: [{ id: "w-new", fallbackChains: chain }], activeWorkspaceId: null });
    const stop = startArmOnFocus();
    layout.layoutState.update((s) => ({ ...s, activeWorkspaceId: "w-new" }));
    expect(get(armRequest)).toBeNull();
    layout.layoutState.update((s) => ({
      ...s,
      workspaces: s.workspaces.map((w) => ({ ...w, rootPath: "/repo/w-new" })),
    }));
    expect(get(armRequest)).toEqual({ workspaceId: "w-new", profileId: "codex" });
    stop();
  });

  it("holds every request until the hold is released", () => {
    layout.layoutState.set({
      workspaces: [{ id: "w-held", rootPath: "/repo/w-held", fallbackChains: chain }],
      activeWorkspaceId: null,
    });
    const stop = startArmOnFocus();
    const release = holdArming();
    layout.layoutState.update((s) => ({ ...s, activeWorkspaceId: "w-held" }));
    expect(get(armRequest)).toBeNull();
    // The flow that took the hold opened the setup wizard before letting go.
    layout.wizardWorkspaceId.set("w-held");
    release();
    release(); // a second release must not free someone else's hold
    expect(get(armRequest)).toBeNull();
    layout.wizardWorkspaceId.set(null);
    expect(get(armRequest)).toEqual({ workspaceId: "w-held", profileId: "codex" });
    stop();
  });
});
