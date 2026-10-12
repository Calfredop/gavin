import { describe, expect, it } from "vitest";
import {
  agentConfigWithAttribution,
  COMPLEXITY_LABELS,
  COMPLEXITY_LEVELS,
  complexityEntryFor,
  complexityTableForPrimary,
  effectiveComplexityTable,
  sameComplexityTable,
  withComplexityTableForPrimary,
  complexityLabel,
  complexitySummary,
  isAttributed,
  parseComplexity,
  realignComplexityTable,
  recommendedComplexityAction,
  withAgentEffort,
  EMPTY_AGENT_DEFAULTS,
  type ComplexityTable,
} from "$lib/cards/complexity";

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
    // An effort alone is a whole row: the workspace's agent, harder.
    expect(isAttributed({ profile: "", model: "", effort: "max" })).toBe(true);
    expect(isAttributed({ profile: "", model: "", effort: " " })).toBe(false);
    // So is an advisor alone: the workspace's agent, with opus to ask.
    expect(isAttributed({ profile: "", model: "", advisor: "opus" })).toBe(true);
    expect(isAttributed({ profile: "", model: "", advisor: " " })).toBe(false);
    expect(isAttributed(undefined)).toBe(false);
    expect(isAttributed(null)).toBe(false);
  });
});

describe("complexityEntryFor", () => {
  const table: ComplexityTable = {
    trivial: { profile: "", model: "haiku" },
    intricate: { profile: "claude-code", model: "opus" },
  };

  it("reads the level's row from the one table it is given", () => {
    expect(complexityEntryFor("intricate", table)).toEqual({ profile: "claude-code", model: "opus" });
    expect(complexityEntryFor("trivial", table)).toEqual({ profile: "", model: "haiku" });
  });

  it("treats an empty row as nothing attributed", () => {
    const empty: ComplexityTable = { trivial: { profile: "", model: "" } };
    expect(complexityEntryFor("trivial", empty)).toBeNull();
  });

  it("answers null for a level nobody attributed, and for no level at all", () => {
    expect(complexityEntryFor("moderate", table)).toBeNull();
    expect(complexityEntryFor(null, table)).toBeNull();
  });
});

describe("per-primary complexity tables", () => {
  const claude: ComplexityTable = { intricate: { profile: "codex", model: "gpt-5.1" } };
  const codex: ComplexityTable = { trivial: { profile: "", model: "mini" } };
  const app = { "claude-code": claude, codex };

  it("reads one primary's app-wide table, empty when it has none", () => {
    expect(complexityTableForPrimary(app, "claude-code")).toBe(claude);
    expect(complexityTableForPrimary(app, "gemini")).toEqual({});
    expect(complexityTableForPrimary(app, "  ")).toEqual({});
    expect(complexityTableForPrimary(null, "codex")).toEqual({});
  });

  /// A workspace map with the key is that primary's WHOLE table; a level
  /// it leaves out runs the workspace's own agent, it does not fall
  /// through to the app's row for that level.
  it("lets a workspace's own table replace the app's whole, per primary", () => {
    const own: ComplexityTable = { trivial: { profile: "", model: "nano" } };
    const ws = { "claude-code": own };
    expect(effectiveComplexityTable(ws, app, "claude-code")).toBe(own);
    expect(effectiveComplexityTable(ws, app, "claude-code").intricate).toBeUndefined();
    // Another primary has no key in the workspace map: it inherits.
    expect(effectiveComplexityTable(ws, app, "codex")).toBe(codex);
  });

  it("reads an own-but-empty workspace table as 'no routing', not as inherit", () => {
    expect(effectiveComplexityTable({ "claude-code": {} }, app, "claude-code")).toEqual({});
  });

  it("inherits when the workspace has no map at all", () => {
    expect(effectiveComplexityTable(undefined, app, "codex")).toBe(codex);
    expect(effectiveComplexityTable(null, null, "codex")).toEqual({});
    expect(effectiveComplexityTable(undefined, app, "")).toEqual({});
  });

  it("sets and removes one primary's table without touching the others", () => {
    const next = withComplexityTableForPrimary(app, "codex", { moderate: { profile: "", model: "m" } });
    expect(next["claude-code"]).toBe(claude);
    expect(next.codex).toEqual({ moderate: { profile: "", model: "m" } });
    expect(withComplexityTableForPrimary(app, "codex", null).codex).toBeUndefined();
    // The caller's map is never mutated.
    expect(app.codex).toBe(codex);
  });

  /// App-wide, an empty table and an absent one are the same thing; in a
  /// workspace the difference is the whole point, so `keepEmpty` keeps it.
  it("drops an empty table app-wide but keeps it for a workspace", () => {
    expect(withComplexityTableForPrimary(app, "codex", {}).codex).toBeUndefined();
    expect(withComplexityTableForPrimary(app, "codex", {}, true).codex).toEqual({});
    expect(withComplexityTableForPrimary(app, "codex", null, true).codex).toBeUndefined();
  });

  it("compares tables level by level, ignoring unattributed rows", () => {
    expect(sameComplexityTable(claude, { ...claude })).toBe(true);
    expect(sameComplexityTable(claude, {})).toBe(false);
    expect(sameComplexityTable({}, { trivial: { profile: "", model: "" } })).toBe(true);
    expect(
      sameComplexityTable(claude, { intricate: { profile: "codex", model: "gpt-5.2" } })
    ).toBe(false);
    expect(
      sameComplexityTable(
        { complex: { profile: "", model: "sonnet" } },
        { complex: { profile: "", model: "sonnet", advisor: "opus" } }
      )
    ).toBe(false);
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
    expect(r).toEqual({ ...base, model: "opus", effort: null });
  });

  it("keeps the workspace's model when the level names only an effort", () => {
    // The D68 case: "max effort" on the workspace's own agent must not
    // quietly drop the model the workspace pinned back to the default.
    const r = agentConfigWithAttribution({ ...base, effort: "low" }, { profile: "", model: "", effort: "max" });
    expect(r).toEqual({ ...base, model: "sonnet", effort: "max" });
    // ...and a model-only level keeps the workspace's effort.
    const m = agentConfigWithAttribution({ ...base, effort: "low" }, { profile: "", model: "opus" });
    expect(m).toEqual({ ...base, model: "opus", effort: "low" });
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
      effort: null,
    });
  });

  it("keeps them when the level names the profile the workspace already runs", () => {
    const r = agentConfigWithAttribution(base, { profile: "claude-code", model: "opus" });
    expect(r).toEqual({ ...base, model: "opus", effort: null });
  });

  it("carries a named effort across a profile switch", () => {
    const r = agentConfigWithAttribution(base, { profile: "codex", model: "", effort: "xhigh" });
    expect(r?.effort).toBe("xhigh");
    expect(r?.model).toBeNull();
  });

  it("lays a named advisor over the config, and adds nothing without one", () => {
    expect(agentConfigWithAttribution(base, { profile: "", model: "", advisor: "opus" })).toEqual({
      ...base,
      model: "sonnet",
      effort: null,
      advisor: "opus",
    });
    expect(
      agentConfigWithAttribution(base, { profile: "codex", model: "", advisor: " fable " })?.advisor
    ).toBe("fable");
    expect(agentConfigWithAttribution(base, { profile: "", model: "opus", advisor: "" })).not.toHaveProperty(
      "advisor"
    );
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

  it("names the effort when the level sets one", () => {
    expect(
      complexitySummary("intricate", { profile: "codex", model: "gpt-5.1", effort: "xhigh" }, label)
    ).toBe("Intricate — runs Codex CLI on gpt-5.1, at xhigh effort.");
    expect(complexitySummary("complex", { profile: "", model: "", effort: "high" }, label)).toBe(
      "Complex — runs this workspace's agent, at high effort."
    );
  });

  it("names the advisor after the effort", () => {
    expect(
      complexitySummary("intricate", { profile: "", model: "sonnet", effort: "high", advisor: "opus" }, label)
    ).toBe("Intricate — runs this workspace's agent on sonnet, at high effort, advised by opus.");
  });

  it("says so when a level is rated but attributed to nothing", () => {
    expect(complexitySummary("moderate", null, label)).toBe(
      "Moderate — runs this workspace's agent."
    );
    expect(complexitySummary(null, null, label)).toBeNull();
  });
});

describe("withAgentEffort", () => {
  it("sets one profile's default and clears it on a blank", () => {
    const set = withAgentEffort(EMPTY_AGENT_DEFAULTS, "claude-code", " high ");
    expect(set.agentEfforts).toEqual({ "claude-code": "high" });
    expect(EMPTY_AGENT_DEFAULTS.agentEfforts).toBeUndefined();
    const cleared = withAgentEffort(set, "claude-code", "");
    expect(cleared.agentEfforts).toEqual({});
    // Everything else rides through untouched: this is a wholesale save.
    expect({ ...cleared, agentEfforts: undefined }).toEqual({ ...EMPTY_AGENT_DEFAULTS, agentEfforts: undefined });
  });
});

describe("realignComplexityTable", () => {
  const table: ComplexityTable = {
    trivial: { profile: "claude-code", model: "haiku" },
    simple: { profile: "", model: "sonnet" },
    intricate: { profile: "codex", model: "gpt-5.1" },
  };

  it("keep leaves every row alone", () => {
    expect(realignComplexityTable(table, "keep", "claude-code", "cursor")).toEqual(table);
  });

  it("remap retargets rows that named the old profile and leaves the rest", () => {
    expect(realignComplexityTable(table, "remap", "claude-code", "cursor")).toEqual({
      trivial: { profile: "cursor", model: "haiku" },
      simple: { profile: "", model: "sonnet" },
      intricate: { profile: "codex", model: "gpt-5.1" },
    });
  });

  it("clear drops every workspace override", () => {
    expect(realignComplexityTable(table, "clear", "claude-code", "cursor")).toEqual({});
  });

  it("does not mutate the table it was handed", () => {
    const copy = structuredClone(table);
    realignComplexityTable(table, "remap", "claude-code", "cursor");
    realignComplexityTable(table, "clear", "claude-code", "cursor");
    expect(table).toEqual(copy);
  });
});

describe("recommendedComplexityAction", () => {
  /// Tables are per agent, so "this workspace's agent" cannot go stale
  /// across a switch, and a row naming the agent being left may be a
  /// deliberate cross-agent route. Rewriting or dropping is the human's
  /// choice, never the default.
  it("recommends keeping, whatever the table says", () => {
    expect(recommendedComplexityAction({}, "claude-code")).toBe("keep");
    expect(
      recommendedComplexityAction({ trivial: { profile: "claude-code", model: "" } }, "claude-code")
    ).toBe("keep");
    expect(
      recommendedComplexityAction(
        { simple: { profile: "", model: "sonnet" }, intricate: { profile: "codex", model: "" } },
        "claude-code"
      )
    ).toBe("keep");
  });
});
