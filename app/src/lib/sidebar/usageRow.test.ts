import { describe, expect, it } from "vitest";
import type { UsageProjection } from "$lib/agents/usageProjection";
import {
  agentAvatarLabels,
  commandArgv0,
  profileIdForCommand,
  runningAgentProfiles,
  usageRowBadges,
} from "$lib/sidebar/usageRow";

describe("agentAvatarLabels", () => {
  it("takes the first letter when names do not collide", () => {
    expect(
      agentAvatarLabels([
        { id: "claude-code", label: "Claude Code" },
        { id: "gemini", label: "Gemini" },
      ])
    ).toEqual({ "claude-code": "C", gemini: "G" });
  });

  it("grows colliding prefixes — Claude Code and Codex become Cl and Co", () => {
    expect(
      agentAvatarLabels([
        { id: "claude-code", label: "Claude Code" },
        { id: "codex", label: "Codex" },
      ])
    ).toEqual({ "claude-code": "Cl", codex: "Co" });
  });

  it("keeps growing until every avatar is unique", () => {
    expect(
      agentAvatarLabels([
        { id: "a", label: "Cursor" },
        { id: "b", label: "Claude Code" },
        { id: "c", label: "Codex" },
      ])
    ).toEqual({ a: "Cu", b: "Cl", c: "Co" });
  });

  it("falls back to the id when the label has no letters", () => {
    expect(agentAvatarLabels([{ id: "opencode", label: "—" }])).toEqual({
      opencode: "O",
    });
  });

  it("leaves identical labels identical once the letters run out", () => {
    expect(
      agentAvatarLabels([
        { id: "a", label: "Codex" },
        { id: "b", label: "Codex" },
      ])
    ).toEqual({ a: "Codex", b: "Codex" });
  });
});

describe("commandArgv0 / profileIdForCommand", () => {
  const profiles = [
    { id: "claude-code", command: "claude" },
    { id: "cursor", command: "agent --approve-mcps --trust" },
    { id: "codex", command: "codex" },
  ];

  it("takes the basename of the first token", () => {
    expect(commandArgv0("/usr/local/bin/claude --model opus")).toBe("claude");
    expect(commandArgv0("agent --approve-mcps --trust")).toBe("agent");
    expect(commandArgv0("C:\\Tools\\claude.exe -p hi")).toBe("claude");
  });

  it("matches a session to its profile by argv0, not the workspace default", () => {
    expect(profileIdForCommand("agent --approve-mcps --trust", profiles)).toBe("cursor");
    expect(profileIdForCommand("claude --model opus 'mention agent'", profiles)).toBe(
      "claude-code"
    );
    expect(profileIdForCommand(null, profiles)).toBeNull();
    expect(profileIdForCommand("bash", profiles)).toBeNull();
  });
});

describe("runningAgentProfiles", () => {
  it("collects profiles with a working session and ignores the rest", () => {
    expect(
      runningAgentProfiles([
        { profileId: "claude-code", status: "working" },
        { profileId: "codex", status: "idle" },
        { profileId: "gemini", status: "waiting_for_input" },
        { profileId: null, status: "working" },
        { profileId: "claude-code", status: "working" },
      ])
    ).toEqual(new Set(["claude-code"]));
  });
});

function projection(
  over: Partial<UsageProjection> & Pick<UsageProjection, "profileId" | "band">
): UsageProjection {
  return {
    windowId: "five_hour",
    label: "5h",
    usedPercent: 40,
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    ratePerHour: 10,
    exhaustAtMs: null,
    endPercent: null,
    marginRatio: over.band === "over" ? -0.2 : over.band === "tight" ? 0.1 : 2,
    status: "projected",
    spanMs: 3_600_000,
    samples: 4,
    ...over,
  };
}

describe("usageRowBadges", () => {
  it("builds one badge per agent with avatar, tone and running flag", () => {
    const badges = usageRowBadges({
      agents: [
        { id: "claude-code", label: "Claude Code" },
        { id: "codex", label: "Codex" },
      ],
      projections: [
        projection({ profileId: "claude-code", band: "clear" }),
        projection({ profileId: "codex", band: "over", usedPercent: 95 }),
      ],
      runningProfileIds: new Set(["codex"]),
      nowMs: 1_700_000_000_000,
    });
    expect(badges.map((b) => [b.profileId, b.avatar, b.tone, b.running])).toEqual([
      ["claude-code", "Cl", "success", false],
      ["codex", "Co", "danger", true],
    ]);
    expect(badges[0].tip).toContain("Claude Code");
    expect(badges[1].tip).toMatch(/^Usage ·/);
  });

  it("stays neutral with the agent name as tip when there is no projection", () => {
    const [badge] = usageRowBadges({
      agents: [{ id: "gemini", label: "Gemini" }],
      projections: [],
      runningProfileIds: new Set(),
      nowMs: 0,
    });
    expect(badge).toMatchObject({
      avatar: "G",
      tone: "neutral",
      tip: "Gemini",
      running: false,
    });
  });
});
