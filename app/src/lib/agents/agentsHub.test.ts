import { describe, expect, it } from "vitest";
import {
  AGENTS_SECTION,
  GENERAL_TAB,
  addCustomProfile,
  agentsHubTabs,
  agentsTabForQuery,
  deleteCustomProfile,
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
    usageProbe: false,
    ...over,
  };
}

const PROFILES: AgentProfileInfo[] = [
  profile({ id: "claude-code", label: "Claude Code", usageProbe: true }),
  profile({ id: "codex", label: "Codex", usageProbe: true }),
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
