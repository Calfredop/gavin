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
      agentFallback?: string[] | null;
      armedAgents?: string[];
      declinedAgents?: string[];
    }>,
    activeWorkspaceId: null as string | null,
  });
  const agentDefaultsStore = store({
    customCommand: "",
    customModelFlag: "",
    complexity: {} as Record<string, { profile: string; model: string }>,
    agentFallback: [] as string[],
  });
  return {
    layoutState,
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

import {
  armNewlyAdded,
  armRequest,
  askAgainToArm,
  completeArmRequest,
  declineArmRequest,
  dismissArmRequest,
  owedArming,
  requestArm,
  startArmOnFocus,
} from "$lib/agents/agentFallbackState";

beforeEach(() => {
  armRequest.set(null);
  layout.layoutState.set({ workspaces: [], activeWorkspaceId: null });
  layout.agentDefaultsStore.set({
    customCommand: "",
    customModelFlag: "",
    complexity: {},
    agentFallback: [],
  });
  layout.resolvedAgentFor.mockReturnValue({ profileId: "claude-code" });
  layout.workspaceComplexityTable.mockReturnValue({});
});

describe("owedArming", () => {
  it("names unarmed chain and complexity profiles, not the workspace agent", () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", agentFallback: ["codex"], armedAgents: [] }],
      activeWorkspaceId: "w1",
    });
    layout.agentDefaultsStore.set({
      customCommand: "",
      customModelFlag: "",
      complexity: { intricate: { profile: "gemini", model: "" } },
      agentFallback: [],
    });
    layout.workspaceComplexityTable.mockReturnValue({});
    expect(owedArming("w1")).toEqual(["codex", "gemini"]);
  });

  it("leaves out an agent the human said not to ask about again", () => {
    layout.layoutState.set({
      workspaces: [{ id: "w1", agentFallback: ["codex", "gemini"], declinedAgents: ["codex"] }],
      activeWorkspaceId: "w1",
    });
    expect(owedArming("w1")).toEqual(["gemini"]);
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
      workspaces: [{ id: "w1", agentFallback: ["gemini"], declinedAgents: ["gemini"] }],
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
      workspaces: [{ id: "w-decline", agentFallback: ["codex"] }],
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
      workspaces: [{ id: "w-again", agentFallback: ["codex"] }],
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
      workspaces: [{ id: "w1", agentFallback: ["codex", "gemini"], armedAgents: [] }],
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
      workspaces: [{ id: "w1", agentFallback: ["codex"], armedAgents: [] }],
      activeWorkspaceId: null,
    });
    const stop = startArmOnFocus();
    layout.layoutState.update((s) => ({ ...s, activeWorkspaceId: "w1" }));
    expect(get(armRequest)).toEqual({ workspaceId: "w1", profileId: "codex" });
    stop();
  });
});
