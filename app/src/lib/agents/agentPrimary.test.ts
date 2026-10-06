import { beforeEach, describe, expect, it, vi } from "vitest";

const layout = vi.hoisted(() => ({
  setAgentDefaults: vi.fn(async () => {}),
  setWorkspaceComplexityTable: vi.fn(async () => {}),
  setWorkspacePause: vi.fn(async () => {}),
  setWorkspacePromptParams: vi.fn(async () => {}),
}));
vi.mock("$lib/core/layoutState", () => layout);

const pauseState = vi.hoisted(() => ({ saveAgentPauseFor: vi.fn(async () => {}) }));
vi.mock("$lib/agents/agentPauseState", () => pauseState);

import { DEFAULT_CYCLE, type PauseCycle } from "$lib/agents/agentPause";
import { EMPTY_AGENT_DEFAULTS, type AgentDefaults } from "$lib/cards/complexity";
import {
  ownCycleSeed,
  ownListSeed,
  primaryView,
  saveComplexityTable,
  saveList,
  savePauseCycle,
} from "./agentPrimary";

const cycle = (over: Partial<PauseCycle> = {}): PauseCycle => ({
  ...DEFAULT_CYCLE,
  enabled: true,
  anchorMs: 7,
  ...over,
});

const defaults: AgentDefaults = {
  ...EMPTY_AGENT_DEFAULTS,
  complexityTables: { codex: { trivial: { profile: "", model: "mini" } } },
  pauseCycles: { codex: cycle({ pauseMinutes: 20 }) },
  promptExtras: { codex: ["Be brief."] },
  extraCliArgs: { codex: ["--app"] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("primaryView in the app scope", () => {
  it("is the app-wide value for the agent, and always owned", () => {
    const view = primaryView("app", "codex", defaults, null);
    expect(view.table).toEqual({ trivial: { profile: "", model: "mini" } });
    expect(view.ownsTable).toBe(true);
    expect(view.ownsCycle).toBe(true);
    expect(view.cycleOrDefault.pauseMinutes).toBe(20);
    expect(view.promptLines).toEqual(["Be brief."]);
    expect(view.cliArgs).toEqual(["--app"]);
    expect(view.ownsPromptLines && view.ownsCliArgs).toBe(true);
  });

  it("gives an agent nothing has been said about empty tables, the default cycle and no lines", () => {
    const view = primaryView("app", "gemini", defaults, null);
    expect(view.table).toEqual({});
    expect(view.appCycle).toBeNull();
    expect(view.cycleOrDefault).toEqual({ ...DEFAULT_CYCLE, anchorMs: 0 });
    expect(view.promptLines).toEqual([]);
    expect(view.cliArgs).toEqual([]);
  });
});

describe("primaryView in the workspace scope", () => {
  it("inherits every block while the workspace holds no key for the agent", () => {
    const view = primaryView("workspace", "codex", defaults, {});
    expect(view.ownsTable).toBe(false);
    expect(view.table).toBe(view.appTable);
    expect(view.ownsCycle).toBe(false);
    expect(view.ownCycle).toBeNull();
    expect(view.appCycle?.pauseMinutes).toBe(20);
    expect(view.ownsPromptLines).toBe(false);
    expect(view.promptLines).toEqual(["Be brief."]);
    expect(view.ownsCliArgs).toBe(false);
    expect(view.cliArgs).toEqual(["--app"]);
  });

  it("owns a block as soon as its key is present, even when it says nothing", () => {
    const view = primaryView("workspace", "codex", defaults, {
      complexityTables: { codex: {} },
      pauseCycles: { codex: cycle({ enabled: false }) },
      promptExtras: { codex: [] },
      extraCliArgs: { codex: [] },
    });
    expect(view.ownsTable).toBe(true);
    // An own empty table is "no routing here", not the app's table.
    expect(view.table).toEqual({});
    expect(view.ownsCycle).toBe(true);
    expect(view.ownCycle?.enabled).toBe(false);
    expect(view.ownsPromptLines).toBe(true);
    expect(view.promptLines).toEqual([]);
    expect(view.cliArgs).toEqual([]);
  });

  it("answers per agent: a key for another agent says nothing about this one", () => {
    const ws = { pauseCycles: { gemini: cycle() }, promptExtras: { gemini: ["x"] } };
    const view = primaryView("workspace", "codex", defaults, ws);
    expect(view.ownsCycle).toBe(false);
    expect(view.ownsPromptLines).toBe(false);
    expect(view.promptLines).toEqual(["Be brief."]);
  });

  it("falls back to the app view while the workspace is not loaded", () => {
    const view = primaryView("workspace", "codex", defaults, null);
    expect(view.table).toBe(view.appTable);
    expect(view.ownsCycle).toBe(false);
  });
});

describe("saves go where the scope says", () => {
  it("writes the app table into the agent defaults, dropping an emptied one", async () => {
    await saveComplexityTable("app", "", "codex", defaults, { moderate: { profile: "", model: "m" } });
    expect(layout.setAgentDefaults).toHaveBeenCalledWith({
      ...defaults,
      complexityTables: { codex: { moderate: { profile: "", model: "m" } } },
    });
    await saveComplexityTable("app", "", "codex", defaults, {});
    expect(layout.setAgentDefaults).toHaveBeenLastCalledWith({ ...defaults, complexityTables: {} });
  });

  it("writes a workspace table to the workspace, null handing it back to the app", async () => {
    await saveComplexityTable("workspace", "ws-1", "codex", defaults, {});
    expect(layout.setWorkspaceComplexityTable).toHaveBeenCalledWith("ws-1", "codex", {});
    await saveComplexityTable("workspace", "ws-1", "codex", defaults, null);
    expect(layout.setWorkspaceComplexityTable).toHaveBeenLastCalledWith("ws-1", "codex", null);
    expect(layout.setAgentDefaults).not.toHaveBeenCalled();
  });

  it("saves a cycle through the app's anchor-stamping writer or the workspace's", async () => {
    await savePauseCycle("app", "", "codex", cycle());
    expect(pauseState.saveAgentPauseFor).toHaveBeenCalledWith("codex", cycle());
    await savePauseCycle("workspace", "ws-1", "codex", null);
    expect(layout.setWorkspacePause).toHaveBeenCalledWith("ws-1", "codex", null);
  });

  it("keeps an emptied app list out of the defaults but an emptied workspace list as 'none'", async () => {
    await saveList("app", "", "codex", defaults, "promptExtras", []);
    expect(layout.setAgentDefaults).toHaveBeenCalledWith({ ...defaults, promptExtras: {} });
    await saveList("workspace", "ws-1", "codex", defaults, "extraCliArgs", []);
    expect(layout.setWorkspacePromptParams).toHaveBeenCalledWith("ws-1", "codex", "extraCliArgs", []);
    await saveList("workspace", "ws-1", "codex", defaults, "extraCliArgs", null);
    expect(layout.setWorkspacePromptParams).toHaveBeenLastCalledWith("ws-1", "codex", "extraCliArgs", null);
  });
});

describe("what taking an own value starts from", () => {
  it("copies the inherited cycle, anchor and all, or the shipped default when there is none", () => {
    const withCycle = primaryView("workspace", "codex", defaults, {});
    expect(ownCycleSeed(withCycle)).toEqual(defaults.pauseCycles.codex);
    expect(ownCycleSeed(withCycle)).not.toBe(defaults.pauseCycles.codex);
    const without = primaryView("workspace", "gemini", defaults, {});
    expect(ownCycleSeed(without)).toEqual({ ...DEFAULT_CYCLE, anchorMs: 0 });
  });

  it("copies the app-wide list", () => {
    expect(ownListSeed(defaults, "promptExtras", "codex")).toEqual(["Be brief."]);
    expect(ownListSeed(defaults, "promptExtras", "codex")).not.toBe(defaults.promptExtras.codex);
    expect(ownListSeed(defaults, "extraCliArgs", "gemini")).toEqual([]);
  });
});
