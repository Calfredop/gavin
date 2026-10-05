import { describe, expect, it } from "vitest";
import {
  AGENTS_SECTION,
  GENERAL_TAB,
  addCustomProfile,
  agentDefaultsWithoutCustom,
  agentsHubTabs,
  agentsTabForQuery,
  deleteCustomProfile,
  fallbackChainsWithoutProfile,
  isCustomProfileId,
  localCustomId,
  renameCustomProfile,
  slugifyCustomId,
  updateCustomProfile,
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
        complexity: {},
        fallbackChains: { "my-bot": ["codex"], "claude-code": ["my-bot", "codex"] },
        fallbackThresholds: { "my-bot": 80, codex: 95 },
        actionPromptOverrides: {},
      },
      "my-bot"
    );
    expect(defaults.customProfiles).toEqual([]);
    expect(defaults.fallbackChains).toEqual({ "claude-code": ["codex"] });
    expect(defaults.fallbackThresholds).toEqual({ codex: 95 });
    // Back to the fallback an absent setting already means.
    expect(defaults.defaultAgent).toBe("claude-code");
  });

  it("keeps the default agent when it names another profile", () => {
    const defaults = agentDefaultsWithoutCustom(
      {
        customProfiles: [{ id: "my-bot", label: "Bot", command: "bot", modelFlag: "" }],
        defaultAgent: "codex",
        complexity: {},
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
