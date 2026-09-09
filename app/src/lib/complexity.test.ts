import { describe, expect, it } from "vitest";
import {
  agentConfigWithAttribution,
  COMPLEXITY_LABELS,
  COMPLEXITY_LEVELS,
  complexityEntry,
  complexityLabel,
  complexitySummary,
  isAttributed,
  parseComplexity,
  type ComplexityTable,
} from "$lib/complexity";

describe("parseComplexity", () => {
  it("accepts every level, however it was typed", () => {
    for (const level of COMPLEXITY_LEVELS) {
      expect(parseComplexity(level)).toBe(level);
      expect(parseComplexity(level.toUpperCase())).toBe(level);
      expect(parseComplexity(`  ${level}  `)).toBe(level);
    }
  });

  // The posture the daemon's `Complexity::parse` takes too, and the
  // reason it differs from `Priority::from_str`: an unreadable priority
  // is cosmetic, an unreadable complexity would pick somebody an agent.
  it("refuses anything else rather than falling back to a level", () => {
    for (const bad of ["gnarly", "", "  ", "hard", "1"]) {
      expect(parseComplexity(bad)).toBeNull();
    }
    expect(parseComplexity(null)).toBeNull();
    expect(parseComplexity(undefined)).toBeNull();
  });

  it("labels every level, and every level explains where its boundary is", () => {
    expect(COMPLEXITY_LEVELS.length).toBe(5);
    for (const level of COMPLEXITY_LEVELS) {
      expect(COMPLEXITY_LABELS[level].label).toBeTruthy();
      expect(COMPLEXITY_LABELS[level].hint).toBeTruthy();
    }
  });

  it("shows a hand-edited value back as itself rather than as nothing", () => {
    expect(complexityLabel("complex")).toBe("Complex");
    expect(complexityLabel("gnarly")).toBe("gnarly");
    expect(complexityLabel(null)).toBe("");
  });
});

describe("isAttributed", () => {
  it("counts a row that names either half, and no other", () => {
    expect(isAttributed({ profile: "codex", model: "" })).toBe(true);
    expect(isAttributed({ profile: "", model: "opus" })).toBe(true);
    expect(isAttributed({ profile: "  ", model: "  " })).toBe(false);
    expect(isAttributed(undefined)).toBe(false);
    expect(isAttributed(null)).toBe(false);
  });
});

describe("complexityEntry", () => {
  const app: ComplexityTable = {
    trivial: { profile: "", model: "haiku" },
    intricate: { profile: "claude-code", model: "opus" },
  };

  it("prefers the workspace's own row for that level", () => {
    const workspace: ComplexityTable = { intricate: { profile: "codex", model: "" } };
    expect(complexityEntry("intricate", app, workspace)).toEqual({ profile: "codex", model: "" });
  });

  // Per LEVEL, not per table: a workspace that only cares about its
  // hardest cards must not lose the app's answer for the other four.
  it("falls through per level, not wholesale", () => {
    const workspace: ComplexityTable = { intricate: { profile: "codex", model: "" } };
    expect(complexityEntry("trivial", app, workspace)).toEqual({ profile: "", model: "haiku" });
  });

  it("treats an empty workspace row as inherit rather than as an override", () => {
    const workspace: ComplexityTable = { trivial: { profile: "", model: "" } };
    expect(complexityEntry("trivial", app, workspace)).toEqual({ profile: "", model: "haiku" });
  });

  it("answers null for a level nobody attributed, and for no level at all", () => {
    expect(complexityEntry("moderate", app, {})).toBeNull();
    expect(complexityEntry(null, app, {})).toBeNull();
  });
});

describe("agentConfigWithAttribution", () => {
  const base = {
    profile: "claude-code",
    file: "CLAUDE.md",
    command: "claude-wrapper",
    mcpFile: ".mcp.json",
    model: "sonnet",
  };

  // The property every launch route depends on: calling this
  // unconditionally must not change what an unrated card does.
  it("hands the base back untouched when nothing is attributed", () => {
    expect(agentConfigWithAttribution(base, null)).toBe(base);
    expect(agentConfigWithAttribution(null, null)).toBeNull();
  });

  it("keeps the whole workspace agent when the level names only a model", () => {
    const r = agentConfigWithAttribution(base, { profile: "", model: "opus" });
    // The wrapper script and the hand-written MCP path survive: it
    // really is the same agent, only the model differs.
    expect(r).toEqual({ ...base, model: "opus" });
  });

  it("drops the workspace's binary-specific keys when the level switches profile", () => {
    const r = agentConfigWithAttribution(base, { profile: "codex", model: "gpt-5.1" });
    expect(r).toEqual({
      profile: "codex",
      file: null,
      command: null,
      mcpFile: null,
      mcpFormat: null,
      model: "gpt-5.1",
    });
  });

  it("keeps them when the level names the profile the workspace already runs", () => {
    const r = agentConfigWithAttribution(base, { profile: "claude-code", model: "opus" });
    expect(r).toEqual({ ...base, model: "opus" });
  });

  it("reads an empty model as the profile's own default, not as a blank", () => {
    expect(agentConfigWithAttribution(base, { profile: "codex", model: "  " })?.model).toBeNull();
  });
});

describe("complexitySummary", () => {
  const label = (id: string) => (id === "codex" ? "Codex CLI" : id);

  it("says what the level will actually run", () => {
    expect(complexitySummary("intricate", { profile: "codex", model: "gpt-5.1" }, label)).toBe(
      "Intricate — runs Codex CLI on gpt-5.1."
    );
    expect(complexitySummary("simple", { profile: "codex", model: "" }, label)).toBe(
      "Simple — runs Codex CLI."
    );
    expect(complexitySummary("trivial", { profile: "", model: "haiku" }, label)).toBe(
      "Trivial — runs this workspace's agent on haiku."
    );
  });

  it("says so when a level is rated but attributed to nothing", () => {
    expect(complexitySummary("moderate", null, label)).toBe(
      "Moderate — runs this workspace's agent."
    );
    expect(complexitySummary(null, null, label)).toBeNull();
  });
});
