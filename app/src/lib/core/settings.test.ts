import { describe, it, expect } from "vitest";
import {
  DEFAULT_ACCENT,
  PALETTE,
  normalizeColor,
  validateAgentFileName,
  validateMcpConfigPath,
  renameDecision,
  accentVar,
  resolveAgentConfig,
  DEFAULT_PRD_PATH,
  validatePrdPath,
  resolvePrdPath,
  relativeToRoot,
  prdPathFromPick,
  agentFileFromPick,
  fieldCommit,
  deleteBlockedReason,
  type AgentProfileInfo,
} from "$lib/core/settings";

const PROFILES: AgentProfileInfo[] = [
  { id: "claude-code", label: "Claude Code", instructionsFile: "CLAUDE.md", command: "claude", mcpSupported: true, mcpConfigFile: ".mcp.json", promptArgs: "", headlessArgs: "-p --allowedTools \"Bash(git *)\" --", modelFlag: "--model", models: ["fable", "opus", "sonnet"], failurePatterns: ["API Error:"], failureCauses: [{ pattern: "/login", cause: "auth" }], sessionIdArgs: "--session-id", sessionIdDiscovery: "", resumeArgs: "--resume", usageProbe: "anthropic-oauth" },
  { id: "codex", label: "Codex CLI", instructionsFile: "AGENTS.md", command: "codex", mcpSupported: true, mcpConfigFile: ".codex/config.toml", promptArgs: "", headlessArgs: "exec --sandbox workspace-write --ask-for-approval never --", modelFlag: "--model", models: [], failurePatterns: [], failureCauses: [], sessionIdArgs: "", sessionIdDiscovery: "", resumeArgs: "", usageProbe: "codex-rollout" },
  { id: "custom", label: "Custom…", instructionsFile: "", command: "", mcpSupported: false, mcpConfigFile: "", promptArgs: null, headlessArgs: "", modelFlag: "", models: [], failurePatterns: [], failureCauses: [], sessionIdArgs: "", sessionIdDiscovery: "", resumeArgs: "", usageProbe: null },
];

describe("normalizeColor", () => {
  it("accepts a six-digit hex in either case", () => {
    expect(normalizeColor("#a78bfa")).toBe("#a78bfa");
    expect(normalizeColor("#A78BFA")).toBe("#a78bfa");
  });

  it("falls back to the default for anything else", () => {
    for (const bad of ["#fff", "red", "", "  ", "#gggggg", "#a78bfa; background: url(x)", "javascript:alert(1)"]) {
      expect(normalizeColor(bad)).toBe(DEFAULT_ACCENT);
    }
    expect(normalizeColor(undefined)).toBe(DEFAULT_ACCENT);
    expect(normalizeColor(null)).toBe(DEFAULT_ACCENT);
  });

  it("offers a palette whose entries all normalize to themselves", () => {
    expect(PALETTE.length).toBe(8);
    expect(PALETTE[0]).toBe(DEFAULT_ACCENT);
    for (const c of PALETTE) expect(normalizeColor(c)).toBe(c);
  });
});

describe("validateAgentFileName", () => {
  it("accepts a bare file name, with or without an extension", () => {
    expect(validateAgentFileName("AGENTS.md")).toBeNull();
    expect(validateAgentFileName(".cursorrules")).toBeNull();
  });

  it("rejects empty, whitespace-only, and anything with a path separator", () => {
    expect(validateAgentFileName("")).toBeTruthy();
    expect(validateAgentFileName("   ")).toBeTruthy();
    expect(validateAgentFileName("docs/AGENTS.md")).toBeTruthy();
    expect(validateAgentFileName("..\\AGENTS.md")).toBeTruthy();
  });
});

describe("validatePrdPath", () => {
  it("accepts a relative path with or without a directory", () => {
    expect(validatePrdPath(DEFAULT_PRD_PATH)).toBeNull();
    expect(validatePrdPath("docs/PRD.md")).toBeNull();
    expect(validatePrdPath("  PRD.md  ")).toBeNull();
  });

  it("rejects anything that could leave the root", () => {
    expect(validatePrdPath("")).toBeTruthy();
    expect(validatePrdPath("   ")).toBeTruthy();
    expect(validatePrdPath("/etc/passwd")).toBeTruthy();
    expect(validatePrdPath("C:\\PRD.md")).toBeTruthy();
    expect(validatePrdPath("../elsewhere/PRD.md")).toBeTruthy();
    expect(validatePrdPath("docs/../../PRD.md")).toBeTruthy();
    // Refused by protocol::usable_prd_path too — the two validators have
    // to agree, or the picker offers a path the daemon then rejects.
    expect(validatePrdPath("./PRD.md")).toBeTruthy();
  });
});

describe("resolvePrdPath", () => {
  it("falls back to the scaffolded path for a workspace that never chose one", () => {
    expect(resolvePrdPath(null)).toBe(DEFAULT_PRD_PATH);
    expect(resolvePrdPath(undefined)).toBe(DEFAULT_PRD_PATH);
    expect(resolvePrdPath({})).toBe(DEFAULT_PRD_PATH);
    expect(resolvePrdPath({ prd: null })).toBe(DEFAULT_PRD_PATH);
    // Whitespace is not a choice.
    expect(resolvePrdPath({ prd: "   " })).toBe(DEFAULT_PRD_PATH);
  });

  it("uses the configured path when there is one", () => {
    expect(resolvePrdPath({ prd: "docs/PRD.md" })).toBe("docs/PRD.md");
    expect(resolvePrdPath({ prd: "  docs/PRD.md  " })).toBe("docs/PRD.md");
  });
});

describe("relativeToRoot", () => {
  it("returns the path below the root", () => {
    expect(relativeToRoot("/a/proj", "/a/proj/docs/PRD.md")).toEqual({ path: "docs/PRD.md" });
    expect(relativeToRoot("/a/proj/", "/a/proj/PRD.md")).toEqual({ path: "PRD.md" });
  });

  it("refuses a sibling whose name merely starts with the root's", () => {
    // The trap this function exists for: a plain startsWith would call
    // /a/proj-old a child of /a/proj and store a path that resolves
    // somewhere else entirely.
    expect(relativeToRoot("/a/proj", "/a/proj-old/PRD.md")).toHaveProperty("error");
  });

  it("refuses the root itself, a parent, and an unrelated path", () => {
    expect(relativeToRoot("/a/proj", "/a/proj")).toHaveProperty("error");
    expect(relativeToRoot("/a/proj", "/a/PRD.md")).toHaveProperty("error");
    expect(relativeToRoot("/a/proj", "/elsewhere/PRD.md")).toHaveProperty("error");
    expect(relativeToRoot("", "/a/proj/PRD.md")).toHaveProperty("error");
  });

  it("treats a Windows pick as the same shape", () => {
    expect(relativeToRoot("C:\\a\\proj", "C:\\a\\proj\\docs\\PRD.md")).toEqual({
      path: "docs/PRD.md",
    });
  });
});

describe("agentFileFromPick", () => {
  it("accepts a file sitting directly in the root", () => {
    expect(agentFileFromPick("/a/proj", "/a/proj/AGENTS.md")).toEqual({ file: "AGENTS.md" });
  });

  it("refuses a subfolder, because the CLI would never read it there", () => {
    const result = agentFileFromPick("/a/proj", "/a/proj/docs/AGENTS.md");
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toMatch(/workspace root/);
  });

  it("refuses a file outside the root", () => {
    expect(agentFileFromPick("/a/proj", "/elsewhere/AGENTS.md")).toHaveProperty("error");
  });
});

describe("prdPathFromPick", () => {
  it("accepts a file anywhere below the root", () => {
    expect(prdPathFromPick("/a/proj", "/a/proj/docs/PRD.md")).toEqual({ path: "docs/PRD.md" });
    expect(prdPathFromPick("/a/proj", "/a/proj/PRD.md")).toEqual({ path: "PRD.md" });
  });

  it("refuses a file outside the root", () => {
    expect(prdPathFromPick("/a/proj", "/elsewhere/PRD.md")).toHaveProperty("error");
  });

  it("refuses a path the daemon would decline, not only one outside", () => {
    // The half a bare relativeToRoot misses: a pick that lands inside the
    // root through a symlinked parent still has to clear usable_prd_path,
    // or the surface offers a write the daemon then refuses.
    const result = prdPathFromPick("/a/proj", "/a/proj/./PRD.md");
    expect(result).toHaveProperty("error");
  });
});

describe("validateMcpConfigPath", () => {
  it("accepts a relative path, with or without a directory", () => {
    expect(validateMcpConfigPath(".myagent/mcp.json")).toBeNull();
    expect(validateMcpConfigPath("opencode.json")).toBeNull();
    expect(validateMcpConfigPath("  tools/mcp/config.toml  ")).toBeNull();
  });

  it("rejects anything that could write outside the root", () => {
    // Same set usable_mcp_path refuses in agent_setup.rs — the two must
    // agree, or the panel offers a write Rust then declines.
    for (const bad of ["", "   ", "/etc/mcp.json", "../outside.json", "a/../../outside.json", "C:\\mcp.json"]) {
      expect(validateMcpConfigPath(bad)).toBeTruthy();
    }
  });
});

describe("renameDecision", () => {
  it("prompts when the old file exists and the target does not", () => {
    expect(renameDecision("CLAUDE.md", "AGENTS.md", true, false)).toBe("prompt");
  });

  it("points when the target already exists — never overwrite", () => {
    expect(renameDecision("CLAUDE.md", "AGENTS.md", true, true)).toBe("point");
  });

  it("points silently when there is no old file to move", () => {
    expect(renameDecision("CLAUDE.md", "AGENTS.md", false, false)).toBe("point");
  });

  it("errors on an invalid new name", () => {
    expect(renameDecision("CLAUDE.md", "a/b.md", true, false)).toBe("error");
    expect(renameDecision("CLAUDE.md", "", true, false)).toBe("error");
  });

  it("points when the name did not actually change", () => {
    expect(renameDecision("CLAUDE.md", "CLAUDE.md", true, false)).toBe("point");
  });
});

describe("resolveAgentConfig", () => {
  it("prefers explicit config over the profile default", () => {
    const r = resolveAgentConfig({ profile: "codex", file: "NOTES.md", command: "codex --x" }, PROFILES, {});
    expect(r).toEqual({
      profileId: "codex",
      label: "Codex CLI",
      file: "NOTES.md",
      command: "codex --x",
      mcpSupported: true,
      mcpConfigFile: ".codex/config.toml",
      headlessArgs: "exec --sandbox workspace-write --ask-for-approval never --",
      promptArgs: "",
      model: "",
      modelFlag: "--model",
      launchCommand: "codex --x",
      failurePatterns: [],
      failureCauses: [],
      sessionIdArgs: "",
      sessionIdDiscovery: "",
      resumeArgs: "",
    });
  });

  it("falls back to the profile's defaults for absent keys", () => {
    const r = resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES, {});
    expect(r.file).toBe("AGENTS.md");
    expect(r.command).toBe("codex");
  });

  it("falls back to claude-code for a missing or unknown profile", () => {
    expect(resolveAgentConfig(null, PROFILES, {})).toEqual({
      profileId: "claude-code", label: "Claude Code", file: "CLAUDE.md", command: "claude",
      mcpSupported: true, mcpConfigFile: ".mcp.json",
      headlessArgs: '-p --allowedTools "Bash(git *)" --', promptArgs: "",
      model: "", modelFlag: "--model", launchCommand: "claude",
      failurePatterns: ["API Error:"],
      failureCauses: [{ pattern: "/login", cause: "auth" }],
      sessionIdArgs: "--session-id", sessionIdDiscovery: "", resumeArgs: "--resume",
    });
    expect(resolveAgentConfig({ profile: "not-a-thing", file: null, command: null }, PROFILES, {}).profileId).toBe(
      "claude-code"
    );
  });

  it("prefers the workspace model over the app-wide default", () => {
    const r = resolveAgentConfig(
      { profile: "claude-code", file: null, command: null, model: "sonnet" },
      PROFILES,
      { "claude-code": "opus" }
    );
    expect(r.model).toBe("sonnet");
    expect(r.launchCommand).toBe("claude --model sonnet");
  });

  it("inherits the app-wide default for the RESOLVED profile only", () => {
    const globals = { "claude-code": "opus", codex: "some-codex-model" };
    expect(
      resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES, globals).model
    ).toBe("some-codex-model");
    // An unknown profile resolves to claude-code, so it inherits
    // claude-code's default -- not the dead row's name it asked for.
    expect(
      resolveAgentConfig({ profile: "nope", file: null, command: null }, PROFILES, globals).model
    ).toBe("opus");
  });

  it("leaves launchCommand equal to command when no model resolves", () => {
    const r = resolveAgentConfig({ profile: "claude-code", file: null, command: null }, PROFILES, {});
    expect(r.model).toBe("");
    expect(r.launchCommand).toBe(r.command);
  });

  it("never folds the model into command", () => {
    // command is what the Settings box writes back to config.toml; a
    // flag folded into it would be persisted and then appended a second
    // time on the next launch.
    const r = resolveAgentConfig(
      { profile: "claude-code", file: null, command: "claude" },
      PROFILES,
      { "claude-code": "opus" }
    );
    expect(r.command).toBe("claude");
    expect(r.launchCommand).toBe("claude --model opus");
  });

  it("adds no flag for a profile that has none", () => {
    const r = resolveAgentConfig(
      { profile: "custom", file: null, command: "my-agent" },
      PROFILES,
      { custom: "whatever" }
    );
    expect(r.model).toBe("whatever");
    expect(r.launchCommand).toBe("my-agent");
  });

  it("treats a blank workspace model as unset", () => {
    const r = resolveAgentConfig(
      { profile: "claude-code", file: null, command: null, model: "  " },
      PROFILES,
      { "claude-code": "opus" }
    );
    expect(r.model).toBe("opus");
  });

  // The profile table is fetched asynchronously and its failure is
  // swallowed, so an empty one is a state the app really reaches. Every
  // other field already answers it by falling back to claude-code's
  // literals; the prompt convention has to fall back WITH the command,
  // or the resolver hands back `claude` and denies it takes a prompt --
  // which would block every card run in the app.
  it("falls back to the bare positional when the table has not loaded", () => {
    const r = resolveAgentConfig(null, [], {});
    expect(r.command).toBe("claude");
    expect(r.promptArgs).toBe("");
  });

  // A row that is THERE and says null keeps its null: the fallback is
  // for an absent table, never between two rows.
  it("never lends one profile's prompt convention to another", () => {
    const r = resolveAgentConfig({ profile: "custom", file: null, command: "my-agent" }, PROFILES, {});
    expect(r.promptArgs).toBeNull();
  });

  it("gives the custom profile the app-wide command and flag when it names none", () => {
    const custom = { command: "my-agent --yolo", modelFlag: "--llm" };
    const r = resolveAgentConfig(
      { profile: "custom", file: "RULES.md", command: null, model: "big" },
      PROFILES,
      {},
      custom
    );
    expect(r.command).toBe("my-agent --yolo");
    expect(r.modelFlag).toBe("--llm");
    // The whole point of the flag: without it there is no way to put a
    // model on a hand-written command, so the model would be dropped.
    expect(r.launchCommand).toBe("my-agent --yolo --llm big");
  });

  it("lets the workspace's own command and flag beat the app-wide custom ones", () => {
    const custom = { command: "my-agent", modelFlag: "--llm" };
    const r = resolveAgentConfig(
      { profile: "custom", file: null, command: "other-agent", modelFlag: "-m", model: "big" },
      PROFILES,
      {},
      custom
    );
    expect(r.command).toBe("other-agent");
    expect(r.launchCommand).toBe("other-agent -m big");
  });

  it("gives the custom profile the app-wide resume flag when the workspace names none", () => {
    const r = resolveAgentConfig(
      { profile: "custom", file: null, command: "my-agent" },
      PROFILES,
      {},
      undefined,
      { app: "--resume-app" }
    );
    expect(r.resumeArgs).toBe("--resume-app");
  });

  it("lets the workspace's own custom resume flag beat the app-wide one", () => {
    const r = resolveAgentConfig(
      { profile: "custom", file: null, command: "my-agent" },
      PROFILES,
      {},
      undefined,
      { workspace: "--resume-ws", app: "--resume-app" }
    );
    expect(r.resumeArgs).toBe("--resume-ws");
  });

  it("leaves a stock profile's verified resume argv alone regardless of the custom config", () => {
    const r = resolveAgentConfig(
      { profile: "claude-code", file: null, command: null },
      PROFILES,
      {},
      undefined,
      { workspace: "--resume-ws", app: "--resume-app" }
    );
    expect(r.resumeArgs).toBe("--resume");
  });

  it("resolves custom with no resume flag configured anywhere to empty", () => {
    const r = resolveAgentConfig({ profile: "custom", file: null, command: "my-agent" }, PROFILES, {});
    expect(r.resumeArgs).toBe("");
  });

  it("never lends the app-wide custom command to a stock profile", () => {
    // The stock rows carry a verified command of their own and have no
    // business inheriting somebody's hand-written one.
    const r = resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES, {}, {
      command: "my-agent",
      modelFlag: "--llm",
    });
    expect(r.command).toBe("codex");
    expect(r.modelFlag).toBe("--model");
  });

  it("lets a workspace flag override the profile table's, on any profile", () => {
    const r = resolveAgentConfig(
      { profile: "claude-code", file: null, command: null, modelFlag: "--pick", model: "opus" },
      PROFILES,
      {}
    );
    expect(r.launchCommand).toBe("claude --pick opus");
  });

  it("keeps custom usable only through its explicit values", () => {
    const r = resolveAgentConfig({ profile: "custom", file: "RULES.md", command: "my-agent" }, PROFILES, {});
    expect(r).toEqual({
      profileId: "custom",
      label: "Custom…",
      file: "RULES.md",
      command: "my-agent",
      mcpSupported: false,
      mcpConfigFile: "",
      headlessArgs: "",
      // Null, not "": an unfilled custom profile takes no prompt, which
      // is a different answer from "its prompt is the bare positional".
      promptArgs: null,
      model: "",
      // Empty, because `custom` has no flag in the table and neither
      // this workspace nor the app-wide default named one: gavin has no
      // verified way to put a model on this command, so every model
      // control for it stays hidden rather than guessing a flag.
      modelFlag: "",
      launchCommand: "my-agent",
      failurePatterns: [],
      failureCauses: [],
      sessionIdArgs: "",
      sessionIdDiscovery: "",
      resumeArgs: "",
    });
    // Custom with nothing filled in still resolves to something safe.
    const bare = resolveAgentConfig({ profile: "custom", file: null, command: null }, PROFILES, {});
    expect(bare.file).toBe("CLAUDE.md");
    expect(bare.command).toBe("claude");
  });

  // The headless argv describes the BINARY, so it never falls back the
  // way file/command do: a bare `custom` borrows claude's command but
  // must NOT borrow claude's flags, and an unfilled one offers no
  // headless run at all.
  it("takes the headless argv from the effective profile only, with no fallback", () => {
    expect(resolveAgentConfig(null, PROFILES, {}).headlessArgs).toBe('-p --allowedTools "Bash(git *)" --');
    expect(resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES, {}).headlessArgs).toBe(
      "exec --sandbox workspace-write --ask-for-approval never --"
    );
    const bare = resolveAgentConfig({ profile: "custom", file: null, command: null }, PROFILES, {});
    expect(bare.command).toBe("claude");
    expect(bare.headlessArgs).toBe("");
  });

  // Same posture as the headless argv above, and the same reason: these
  // three describe the BINARY. Claude Code's `--session-id` on somebody
  // else's agent is garbage in its argv, and its error text on somebody
  // else's screen would paint healthy sessions as broken.
  it("takes the failure and resume argv from the effective profile only", () => {
    const claude = resolveAgentConfig(null, PROFILES, {});
    expect(claude.failurePatterns).toEqual(["API Error:"]);
    expect(claude.sessionIdArgs).toBe("--session-id");
    expect(claude.resumeArgs).toBe("--resume");
    const codex = resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES, {});
    expect(codex.failurePatterns).toEqual([]);
    expect(codex.resumeArgs).toBe("");
    // A bare `custom` borrows claude's COMMAND and none of its argv.
    const bare = resolveAgentConfig({ profile: "custom", file: null, command: null }, PROFILES, {});
    expect(bare.command).toBe("claude");
    expect(bare.failurePatterns).toEqual([]);
    expect(bare.sessionIdArgs).toBe("");
  });

  // An overridden `command` is nearly always a wrapper or an absolute
  // path to the SAME binary, so it keeps the profile's argv -- losing
  // failure detection for everyone who pins a path would be the worse
  // failure of the two.
  it("keeps the profile's argv when only the command is overridden", () => {
    const r = resolveAgentConfig(
      { profile: "claude-code", file: null, command: "/opt/bin/claude" },
      PROFILES,
      {}
    );
    expect(r.failurePatterns).toEqual(["API Error:"]);
    expect(r.sessionIdArgs).toBe("--session-id");
  });

  it("gives custom MCP support the moment a config file is named for it", () => {
    // The one profile with no verified layout of its own: its support
    // follows from config, the same resolution order as every other field.
    const bare = resolveAgentConfig({ profile: "custom", file: null, command: null }, PROFILES, {});
    expect(bare.mcpSupported).toBe(false);
    expect(bare.mcpConfigFile).toBe("");

    const named = resolveAgentConfig(
      { profile: "custom", file: null, command: null, mcpFile: ".myagent/mcp.json" },
      PROFILES,
      {}
    );
    expect(named.mcpSupported).toBe(true);
    expect(named.mcpConfigFile).toBe(".myagent/mcp.json");

    // A cleared box is not an override, here as everywhere else.
    const cleared = resolveAgentConfig(
      { profile: "custom", file: null, command: null, mcpFile: "  " },
      PROFILES,
      {}
    );
    expect(cleared.mcpSupported).toBe(false);

    // Nor is a path Rust would refuse: a hand-edited config.toml must not
    // make the panel offer a write that cannot happen.
    const escaping = resolveAgentConfig(
      { profile: "custom", file: null, command: null, mcpFile: "../outside.json" },
      PROFILES,
      {}
    );
    expect(escaping.mcpSupported).toBe(false);
    expect(escaping.mcpConfigFile).toBe("");
  });

  it("never lets a config path override a profile's verified layout", () => {
    const r = resolveAgentConfig(
      { profile: "codex", file: null, command: null, mcpFile: ".somewhere/else.json" },
      PROFILES,
      {}
    );
    expect(r.mcpConfigFile).toBe(".codex/config.toml");
  });

  it("is empty-string safe — a cleared field is not an override", () => {
    const r = resolveAgentConfig({ profile: "codex", file: "  ", command: "" }, PROFILES, {});
    expect(r.file).toBe("AGENTS.md");
    expect(r.command).toBe("codex");
  });
});

describe("accentVar", () => {
  it("returns a normalized colour when one is set", () => {
    expect(accentVar("#A78BFA")).toBe("#a78bfa");
  });

  it("returns undefined when unset, so each indicator keeps its own default", () => {
    expect(accentVar(undefined)).toBeUndefined();
    expect(accentVar(null)).toBeUndefined();
    expect(accentVar("")).toBeUndefined();
    expect(accentVar("   ")).toBeUndefined();
  });

  it("still normalizes junk rather than passing it into CSS", () => {
    expect(accentVar("red; background: url(x)")).toBe(DEFAULT_ACCENT);
  });
});

describe("accentVar light-mode legibility", () => {
  // Contrast helpers, kept local to the test so the assertion is
  // independent of whatever the implementation computes.
  const chan = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("leaves every swatch untouched in dark mode", () => {
    for (const swatch of PALETTE) {
      expect(accentVar(swatch, "dark")).toBe(swatch);
    }
  });

  it("brings every swatch to at least 3:1 on a light surface", () => {
    for (const swatch of PALETTE) {
      const resolved = accentVar(swatch, "light")!;
      expect(contrast(resolved, "#ffffff")).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps a swatch recognisable rather than collapsing it to grey", () => {
    // Same hue family: the dominant channel must stay dominant.
    for (const swatch of PALETTE) {
      const resolved = accentVar(swatch, "light")!;
      const chanOf = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const a = chanOf(swatch);
      const b = chanOf(resolved);
      expect(b.indexOf(Math.max(...b))).toBe(a.indexOf(Math.max(...a)));
    }
  });

  it("darkens an arbitrary hand-edited colour too, not just the presets", () => {
    // #fbbf24-like brightness, but not in PALETTE.
    const resolved = accentVar("#ffe066", "light")!;
    expect(contrast(resolved, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("returns undefined for an unset colour in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(accentVar(null, theme)).toBeUndefined();
      expect(accentVar(undefined, theme)).toBeUndefined();
      expect(accentVar("   ", theme)).toBeUndefined();
    }
  });
});

describe("fieldCommit", () => {
  it("skips a draft that says what the field already says", () => {
    expect(fieldCommit("claude", "claude", { empty: "keep" })).toEqual({ kind: "skip" });
    expect(fieldCommit("claude", "claude", { empty: "clear" })).toEqual({ kind: "skip" });
  });

  // Trimmed once, here, so no caller writes a change that is only
  // whitespace.
  it("trims before deciding and before writing", () => {
    expect(fieldCommit("  claude  ", "claude", { empty: "keep" })).toEqual({ kind: "skip" });
    expect(fieldCommit("  codex  ", "claude", { empty: "keep" })).toEqual({ kind: "write", value: "codex" });
    expect(fieldCommit("   ", "claude", { empty: "keep" })).toEqual({ kind: "skip" });
  });

  // A name and a command cannot be "": blanking the box is a slip, and
  // the field keeps what it had until something is typed.
  it("writes nothing for an empty box where empty is not a value", () => {
    expect(fieldCommit("", "My workspace", { empty: "keep" })).toEqual({ kind: "skip" });
  });

  // "" is a real value on the wire for an overridable key: it is how the
  // daemon is told to REMOVE it rather than store a blank.
  it("writes the empty string to clear an override", () => {
    expect(fieldCommit("", "opus", { empty: "clear" })).toEqual({ kind: "write", value: "" });
  });

  it("writes nothing when there is no override left to clear", () => {
    expect(fieldCommit("", "", { empty: "clear" })).toEqual({ kind: "skip" });
  });

  // The asymmetry `stored` exists for: an inheriting field SHOWS the
  // value it fell back to, so clearing it must ask what is stored, not
  // what is displayed -- otherwise every blur on an already-inheriting
  // field is a pointless round trip.
  it("asks the stored value, not the shown one, before clearing", () => {
    expect(fieldCommit("", ".gavin-root/PRD.md", { empty: "clear", stored: "" })).toEqual({ kind: "skip" });
    expect(fieldCommit("", ".gavin-root/PRD.md", { empty: "clear", stored: "docs/PRD.md" })).toEqual({
      kind: "write",
      value: "",
    });
  });

  // And a non-empty draft still compares against what is SHOWN: typing
  // the inherited value back is a no-op, not an override set to the same
  // thing.
  it("compares a typed value against what the box was showing", () => {
    expect(
      fieldCommit(".gavin-root/PRD.md", ".gavin-root/PRD.md", { empty: "clear", stored: "" })
    ).toEqual({ kind: "skip" });
  });
});

describe("deleteBlockedReason", () => {
  it("is null for an ordinary workspace with a root", () => {
    expect(deleteBlockedReason(false, true)).toBeNull();
  });

  // Pinned whether or not it has a root: "bind a root folder" would be
  // advice that leads nowhere.
  it("names the Scratchpad first, root or no root", () => {
    expect(deleteBlockedReason(true, true)).toContain("Scratchpad");
    expect(deleteBlockedReason(true, false)).toContain("Scratchpad");
  });

  it("says a rootless workspace has nothing on disk to delete", () => {
    expect(deleteBlockedReason(false, false)).toContain("Bind a root folder");
  });
});
