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
  type AgentProfileInfo,
} from "./settings";

const PROFILES: AgentProfileInfo[] = [
  { id: "claude-code", label: "Claude Code", instructionsFile: "CLAUDE.md", command: "claude", mcpSupported: true, mcpConfigFile: ".mcp.json", promptArg: true, headlessArgs: "-p --allowedTools \"Bash(git *)\" --", modelFlag: "--model", models: ["fable", "opus", "sonnet"], failurePatterns: ["API Error:"], sessionIdArgs: "--session-id", resumeArgs: "--resume" },
  { id: "codex", label: "Codex CLI", instructionsFile: "AGENTS.md", command: "codex", mcpSupported: true, mcpConfigFile: ".codex/config.toml", promptArg: true, headlessArgs: "", modelFlag: "--model", models: [], failurePatterns: [], sessionIdArgs: "", resumeArgs: "" },
  { id: "custom", label: "Custom…", instructionsFile: "", command: "", mcpSupported: false, mcpConfigFile: "", promptArg: false, headlessArgs: "", modelFlag: "", models: [], failurePatterns: [], sessionIdArgs: "", resumeArgs: "" },
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
      file: "NOTES.md",
      command: "codex --x",
      mcpSupported: true,
      mcpConfigFile: ".codex/config.toml",
      headlessArgs: "",
      model: "",
      launchCommand: "codex --x",
      failurePatterns: [],
      sessionIdArgs: "",
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
      profileId: "claude-code", file: "CLAUDE.md", command: "claude",
      mcpSupported: true, mcpConfigFile: ".mcp.json",
      headlessArgs: '-p --allowedTools "Bash(git *)" --',
      model: "", launchCommand: "claude",
      failurePatterns: ["API Error:"], sessionIdArgs: "--session-id", resumeArgs: "--resume",
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

  it("keeps custom usable only through its explicit values", () => {
    const r = resolveAgentConfig({ profile: "custom", file: "RULES.md", command: "my-agent" }, PROFILES, {});
    expect(r).toEqual({
      profileId: "custom",
      file: "RULES.md",
      command: "my-agent",
      mcpSupported: false,
      mcpConfigFile: "",
      headlessArgs: "",
      model: "",
      launchCommand: "my-agent",
      failurePatterns: [],
      sessionIdArgs: "",
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
    expect(resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES, {}).headlessArgs).toBe("");
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
