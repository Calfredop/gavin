import { describe, expect, it } from "vitest";
import {
  ADD_TAB,
  ADD_TAB_HINT,
  AGENTS_SECTION,
  GENERAL_TAB,
  addCustomProfile,
  agentDefaultsWithoutCustom,
  agentsHubTabs,
  agentsTabForQuery,
  complexityTablesWithoutProfile,
  deleteCustomProfile,
  fallbackChainsWithoutProfile,
  isCustomProfileId,
  localCustomId,
  renameCustomProfile,
  slugifyCustomId,
  updateCustomProfile,
  validAgentsTab,
  workspacePatchWithoutProfile,
} from "./agentsHub";
import type { AgentProfileInfo } from "$lib/core/settings";

function profile(
  over: Partial<AgentProfileInfo> & Pick<AgentProfileInfo, "id" | "label">
): AgentProfileInfo {
  return {
    command: over.id,
    instructionsFile: "",
    mcpSupported: false,
    mcpConfigFile: "",
    promptArgs: "",
    headlessArgs: "",
    modelFlag: "",
    models: [],
    effortFlag: "",
    efforts: [],
    failurePatterns: [],
    failureCauses: [],
    sessionIdArgs: "",
    sessionIdDiscovery: "",
    resumeArgs: "",
    usageProbe: null,
    ...over,
  };
}

const PROFILES: AgentProfileInfo[] = [
  profile({ id: "claude-code", label: "Claude Code", usageProbe: "anthropic-oauth" }),
  profile({ id: "codex", label: "Codex", usageProbe: "codex-rollout" }),
  profile({ id: "work-agent", label: "Work", modelFlag: "--model" }),
  profile({ id: "local:desk", label: "Desk", local: true }),
];

describe("agents hub tabs", () => {
  it("is General plus one tab per agent, locals marked", () => {
    expect(agentsHubTabs(PROFILES).map((t) => t.label)).toEqual([
      "General",
      "Claude Code",
      "Codex",
      "Work",
      "Desk (local)",
    ]);
    expect(agentsHubTabs(PROFILES)[0].id).toBe(GENERAL_TAB);
  });

  it("search section is a single agents id with the old pane keywords", () => {
    expect(AGENTS_SECTION.id).toBe("agents");
    expect(AGENTS_SECTION.keywords[0]).toBe("Agents");
    for (const word of [
      "General",
      "Default agent",
      "Agent defaults",
      "Custom agent",
      "API family",
      "quota",
      "rate limit",
      "Agent pause",
      "Complexity",
      "Fallback",
    ]) {
      expect(AGENTS_SECTION.keywords).toContain(word);
    }
  });
});

describe("agentsTabForQuery", () => {
  it("opens General for complexity / pause / default", () => {
    expect(agentsTabForQuery("app", "complexity", PROFILES)).toBe(GENERAL_TAB);
    expect(agentsTabForQuery("app", "pause cycle", PROFILES)).toBe(GENERAL_TAB);
    expect(agentsTabForQuery("workspace", "default agent", PROFILES)).toBe(GENERAL_TAB);
  });

  it("opens a named agent for quota / custom / command", () => {
    expect(agentsTabForQuery("app", "quota", PROFILES)).toBe("claude-code");
    expect(agentsTabForQuery("app", "API family", PROFILES)).toBe("work-agent");
    expect(agentsTabForQuery("workspace", "Codex", PROFILES)).toBe("codex");
  });

  it("treats custom ids as customs", () => {
    expect(isCustomProfileId("work-agent")).toBe(true);
    expect(isCustomProfileId("local:desk")).toBe(true);
    expect(isCustomProfileId("claude-code")).toBe(false);
    expect(isCustomProfileId("general")).toBe(false);
  });
});

describe("customProfiles CRUD helpers", () => {
  it("slugifies and avoids stock ids", () => {
    expect(slugifyCustomId("My Agent!", [])).toBe("my-agent");
    expect(slugifyCustomId("Claude Code", [])).toBe("claude-code-agent");
    expect(slugifyCustomId("custom", ["custom-agent"])).toBe("custom-agent-2");
  });

  it("adds / renames / deletes; locals keep the local: prefix", () => {
    let list = addCustomProfile([], "Work Agent");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("work-agent");
    expect(list[0].command).toBe("");

    list = addCustomProfile(list, "Desk", { local: true });
    expect(list[1].id).toBe(localCustomId("desk"));

    list = renameCustomProfile(list, "work-agent", "Work");
    expect(list[0].label).toBe("Work");

    list = updateCustomProfile(list, "work-agent", {
      command: "my-cli",
      modelFlag: "--model",
      apiFamily: "openai",
    });
    expect(list[0].command).toBe("my-cli");
    expect(list[0].apiFamily).toBe("openai");

    list = deleteCustomProfile(list, "local:desk");
    expect(list.map((p) => p.id)).toEqual(["work-agent"]);
  });
});

describe("deleting a custom cleans its references", () => {
  it("drops its chain key, its mentions in other chains, its threshold, and a default agent naming it", () => {
    const defaults = agentDefaultsWithoutCustom(
      {
        customProfiles: [{ id: "my-bot", label: "Bot", command: "bot", modelFlag: "" }],
        defaultAgent: "my-bot",
        complexityTables: {
          "my-bot": { trivial: { profile: "", model: "mini" } },
          "claude-code": {
            trivial: { profile: "", model: "haiku" },
            intricate: { profile: "my-bot", model: "x" },
          },
        },
        pauseCycles: { "my-bot": { enabled: true, periodMinutes: 300, pauseMinutes: 10, anchorMs: 1, limitPercent: 95, limitEnabled: true } },
        promptExtras: { "my-bot": ["a"], codex: ["b"] },
        extraCliArgs: { "my-bot": ["--x"] },
        fallbackChains: { "my-bot": ["codex"], "claude-code": ["my-bot", "codex"] },
        fallbackThresholds: { "my-bot": 80, codex: 95 },
        actionPromptOverrides: {},
      },
      "my-bot"
    );
    expect(defaults.customProfiles).toEqual([]);
    expect(defaults.fallbackChains).toEqual({ "claude-code": ["codex"] });
    expect(defaults.fallbackThresholds).toEqual({ codex: 95 });
    // Everything else keyed by it goes too, and a row routing a level to
    // it is cleared rather than left pointing at an agent that is gone.
    expect(defaults.complexityTables).toEqual({
      "claude-code": { trivial: { profile: "", model: "haiku" } },
    });
    expect(defaults.pauseCycles).toEqual({});
    expect(defaults.promptExtras).toEqual({ codex: ["b"] });
    expect(defaults.extraCliArgs).toEqual({});
    // Back to the fallback an absent setting already means.
    expect(defaults.defaultAgent).toBe("claude-code");
  });

  it("keeps the default agent when it names another profile", () => {
    const defaults = agentDefaultsWithoutCustom(
      {
        customProfiles: [{ id: "my-bot", label: "Bot", command: "bot", modelFlag: "" }],
        defaultAgent: "codex",
        complexityTables: {},
        pauseCycles: {},
        promptExtras: {},
        extraCliArgs: {},
        fallbackChains: {},
        fallbackThresholds: {},
        actionPromptOverrides: {},
      },
      "my-bot"
    );
    expect(defaults.defaultAgent).toBe("codex");
  });

  it("strips a profile from a workspace chains map the same way", () => {
    expect(
      fallbackChainsWithoutProfile(
        { "local:bot": ["codex"], "claude-code": ["local:bot", "gemini"] },
        "local:bot"
      )
    ).toEqual({ "claude-code": ["gemini"] });
  });
});

describe("the trailing + tab", () => {
  const profiles = [profile({ id: "claude-code", label: "Claude Code" }), profile({ id: "codex", label: "Codex" })];

  it("is added only when a hint is given, after every agent", () => {
    expect(agentsHubTabs(profiles).map((t) => t.id)).toEqual([GENERAL_TAB, "claude-code", "codex"]);
    const tabs = agentsHubTabs(profiles, ADD_TAB_HINT.app);
    expect(tabs.map((t) => t.id)).toEqual([GENERAL_TAB, "claude-code", "codex", ADD_TAB]);
    expect(tabs.at(-1)).toMatchObject({ label: "+", hint: ADD_TAB_HINT.app });
    // No other tab carries a hint: the tooltip is the "+" tab's alone.
    expect(tabs.slice(0, -1).every((t) => t.hint === undefined)).toBe(true);
  });

  it("is never a custom profile id", () => {
    expect(isCustomProfileId(ADD_TAB)).toBe(false);
    expect(isCustomProfileId(GENERAL_TAB)).toBe(false);
    expect(isCustomProfileId("my-bot")).toBe(true);
  });

  it("keeps General, the + tab and existing agents; sends a vanished agent to General", () => {
    expect(validAgentsTab(GENERAL_TAB, profiles, true)).toBe(GENERAL_TAB);
    expect(validAgentsTab(ADD_TAB, profiles, true)).toBe(ADD_TAB);
    expect(validAgentsTab(ADD_TAB, profiles, false)).toBe(GENERAL_TAB);
    expect(validAgentsTab("codex", profiles, true)).toBe("codex");
    expect(validAgentsTab("deleted-custom", profiles, true)).toBe(GENERAL_TAB);
  });

  it("opens for a search about adding a custom", () => {
    expect(agentsTabForQuery("app", "add custom", profiles)).toBe(ADD_TAB);
    expect(agentsTabForQuery("workspace", "new local custom agent", profiles)).toBe(ADD_TAB);
    expect(agentsTabForQuery("app", "customs", profiles)).toBe(ADD_TAB);
  });

  it("says the add hint differently for the two scopes", () => {
    expect(ADD_TAB_HINT.app).not.toBe(ADD_TAB_HINT.workspace);
    expect(ADD_TAB_HINT.workspace).toMatch(/only exist in this workspace/);
  });
});

describe("cleaning a deleted local custom out of a workspace's own maps", () => {
  const cycle = { enabled: true, periodMinutes: 300, pauseMinutes: 10, anchorMs: 1, limitPercent: 95, limitEnabled: true };

  it("clears every per-agent key it appears in, and rows routing to it", () => {
    const patch = workspacePatchWithoutProfile(
      {
        fallbackChains: { "local:bot": ["codex"], "claude-code": ["local:bot", "gemini"] },
        complexityTables: {
          "local:bot": { trivial: { profile: "", model: "mini" } },
          "claude-code": { intricate: { profile: "local:bot", model: "x" }, trivial: { profile: "", model: "haiku" } },
        },
        pauseCycles: { "local:bot": cycle, codex: cycle },
        promptExtras: { "local:bot": ["a"] },
        extraCliArgs: { codex: ["--keep"] },
      },
      "local:bot"
    );
    expect(patch.fallbackChains).toEqual({ "claude-code": ["gemini"] });
    expect(patch.complexityTables).toEqual({ "claude-code": { trivial: { profile: "", model: "haiku" } } });
    expect(patch.pauseCycles).toEqual({ codex: cycle });
    // Emptied maps are stored as absent (inherit) rather than as {}.
    expect(patch.promptExtras).toBeNull();
    // Untouched keys are not in the patch at all.
    expect("extraCliArgs" in patch).toBe(false);
  });

  it("is an empty patch when the profile appears nowhere", () => {
    expect(
      workspacePatchWithoutProfile(
        { fallbackChains: { codex: ["gemini"] }, pauseCycles: { codex: cycle } },
        "local:bot"
      )
    ).toEqual({});
    expect(workspacePatchWithoutProfile({}, "local:bot")).toEqual({});
  });

  /// A workspace's own empty table means "no routing here"; emptying one
  /// by deleting an agent it routed to must not quietly turn it back into
  /// "inherit the app-wide table".
  it("keeps a workspace complexity table that the cleanup emptied", () => {
    const patch = workspacePatchWithoutProfile(
      { complexityTables: { "claude-code": { intricate: { profile: "local:bot", model: "" } } } },
      "local:bot"
    );
    expect(patch.complexityTables).toEqual({ "claude-code": {} });
  });

  it("drops an emptied table app-wide", () => {
    expect(
      complexityTablesWithoutProfile({ "claude-code": { intricate: { profile: "bot", model: "" } } }, "bot")
    ).toEqual({});
  });
});
