import { describe, expect, it } from "vitest";
import { DEFAULT_CYCLE } from "$lib/agents/agentPause";
import type { AgentProfileInfo } from "$lib/core/settings";
import { folderLine, inheritedPauseLine, workspaceAgentView } from "$companion/surfaces/phoneSettings";

describe("what a workspace with no pause of its own follows", () => {
  it("names the app-wide cycle when there is one", () => {
    expect(inheritedPauseLine({ ...DEFAULT_CYCLE, enabled: true, pauseMinutes: 20, periodMinutes: 300, anchorMs: 1 })).toBe(
      "Following the app-wide cycle: 20 minutes every 300 minutes."
    );
  });

  it("says the app-wide setting is off when it is, or when there is none", () => {
    expect(inheritedPauseLine(null)).toMatch(/^Following the app-wide setting, which is off\./);
    expect(inheritedPauseLine({ ...DEFAULT_CYCLE, enabled: false, anchorMs: 0 })).toMatch(/which is off/);
  });
});

describe("where a workspace works", () => {
  it("is its folder, the host for one on another machine, or none", () => {
    expect(folderLine({ rootPath: "/Users/me/code/app" })).toBe("/Users/me/code/app");
    expect(folderLine({ rootPath: "/srv/app", ssh: { host: "build-box" } })).toBe("build-box: /srv/app");
    expect(folderLine({})).toBe("No folder");
    expect(folderLine({ rootPath: "  " })).toBe("No folder");
  });
});

describe("a workspace's agent, for its pickers", () => {
  const CLAUDE = {
    id: "claude-code",
    label: "Claude Code",
    modelFlag: "--model",
    models: ["opus", "sonnet"],
    effortFlag: "--effort",
    efforts: ["low", "high"],
  } as AgentProfileInfo;

  it("tells what the workspace set of its own from what it inherits", () => {
    const view = workspaceAgentView({
      resolved: { profileId: "claude-code", modelFlag: "--model", effortFlag: "--effort" },
      own: { profile: "claude-code", file: null, command: null, model: "sonnet", effort: null },
      profiles: [CLAUDE],
      modelDefaults: { "claude-code": "opus" },
      effortDefaults: { "claude-code": "high" },
    });
    expect(view).toEqual({
      profileLabel: "Claude Code",
      modelFlag: "--model",
      models: ["opus", "sonnet"],
      ownModel: "sonnet",
      inheritedModel: "opus",
      effortFlag: "--effort",
      efforts: ["low", "high"],
      ownEffort: "",
      inheritedEffort: "high",
    });
  });

  it("says nothing it does not know about a profile the table does not have yet", () => {
    const view = workspaceAgentView({
      resolved: { profileId: "custom", modelFlag: "", effortFlag: "" },
      own: null,
      profiles: [],
      modelDefaults: {},
      effortDefaults: undefined,
    });
    expect(view).toMatchObject({ profileLabel: "custom", models: [], ownModel: "", inheritedEffort: "" });
  });
});
