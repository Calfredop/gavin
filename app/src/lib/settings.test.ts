import { describe, it, expect } from "vitest";
import {
  DEFAULT_ACCENT,
  PALETTE,
  normalizeColor,
  validateAgentFileName,
  renameDecision,
  accentVar,
  resolveAgentConfig,
  type AgentProfileInfo,
} from "./settings";

const PROFILES: AgentProfileInfo[] = [
  { id: "claude-code", label: "Claude Code", instructionsFile: "CLAUDE.md", command: "claude", mcpSupported: true },
  { id: "codex", label: "Codex CLI", instructionsFile: "AGENTS.md", command: "codex", mcpSupported: false },
  { id: "custom", label: "Custom…", instructionsFile: "", command: "", mcpSupported: false },
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
    const r = resolveAgentConfig({ profile: "codex", file: "NOTES.md", command: "codex --x" }, PROFILES);
    expect(r).toEqual({ profileId: "codex", file: "NOTES.md", command: "codex --x", mcpSupported: false });
  });

  it("falls back to the profile's defaults for absent keys", () => {
    const r = resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES);
    expect(r.file).toBe("AGENTS.md");
    expect(r.command).toBe("codex");
  });

  it("falls back to claude-code for a missing or unknown profile", () => {
    expect(resolveAgentConfig(null, PROFILES)).toEqual({
      profileId: "claude-code", file: "CLAUDE.md", command: "claude", mcpSupported: true,
    });
    expect(resolveAgentConfig({ profile: "not-a-thing", file: null, command: null }, PROFILES).profileId).toBe(
      "claude-code"
    );
  });

  it("keeps custom usable only through its explicit values", () => {
    const r = resolveAgentConfig({ profile: "custom", file: "RULES.md", command: "my-agent" }, PROFILES);
    expect(r).toEqual({ profileId: "custom", file: "RULES.md", command: "my-agent", mcpSupported: false });
    // Custom with nothing filled in still resolves to something safe.
    const bare = resolveAgentConfig({ profile: "custom", file: null, command: null }, PROFILES);
    expect(bare.file).toBe("CLAUDE.md");
    expect(bare.command).toBe("claude");
  });

  it("is empty-string safe — a cleared field is not an override", () => {
    const r = resolveAgentConfig({ profile: "codex", file: "  ", command: "" }, PROFILES);
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
