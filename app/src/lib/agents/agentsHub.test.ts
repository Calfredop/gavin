import { describe, expect, it } from "vitest";
import {
  AGENTS_SECTION,
  APP_AGENTS_TABS,
  WORKSPACE_AGENTS_TABS,
  addCustomProfile,
  agentsTabForQuery,
  deleteCustomProfile,
  localCustomId,
  renameCustomProfile,
  slugifyCustomId,
  updateCustomProfile,
} from "./agentsHub";

describe("agents hub tabs", () => {
  it("app tabs are Defaults | Customs | Complexity | Fallback | Pause", () => {
    expect(APP_AGENTS_TABS.map((t) => t.label)).toEqual([
      "Defaults",
      "Customs",
      "Complexity",
      "Fallback",
      "Pause",
    ]);
  });

  it("workspace tabs are This agent | Customs | Complexity | Fallback | Pause", () => {
    expect(WORKSPACE_AGENTS_TABS.map((t) => t.label)).toEqual([
      "This agent",
      "Customs",
      "Complexity",
      "Fallback",
      "Pause",
    ]);
  });

  it("search section is a single agents id with the old pane keywords", () => {
    expect(AGENTS_SECTION.id).toBe("agents");
    expect(AGENTS_SECTION.keywords[0]).toBe("Agents");
    for (const word of [
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
  it("opens Customs for API-family / command queries", () => {
    expect(agentsTabForQuery("app", "API family")).toBe("customs");
    expect(agentsTabForQuery("workspace", "named custom")).toBe("customs");
  });

  it("opens Fallback for quota / arm", () => {
    expect(agentsTabForQuery("app", "quota")).toBe("fallback");
    expect(agentsTabForQuery("workspace", "arm fallback")).toBe("fallback");
  });

  it("does not invent This agent on the app hub", () => {
    expect(agentsTabForQuery("app", "this agent profile")).toBe("defaults");
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
