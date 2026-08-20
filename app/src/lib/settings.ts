import type { AgentConfig } from "./gavin";

/// Mirrors AgentProfileDto from agent_setup.rs, fetched via
/// backend.agentProfiles(). Never duplicated as a literal table here --
/// Rust is the single source of truth.
export interface AgentProfileInfo {
  id: string;
  label: string;
  instructionsFile: string;
  command: string;
  mcpSupported: boolean;
}

export const DEFAULT_ACCENT = "#4a9eff";

/// Eight presets chosen to stay legible against the #1e1e1e/#2a2a2a
/// chrome. The default is first so the palette's first swatch is the
/// current look.
export const PALETTE = [
  DEFAULT_ACCENT,
  "#59c36a",
  "#2dd4bf",
  "#a78bfa",
  "#f472b6",
  "#f87171",
  "#fb923c",
  "#fbbf24",
] as const;

const HEX = /^#[0-9a-f]{6}$/i;

/// Validated BEFORE the value reaches a style attribute: a hand-edited
/// config.json must never be able to inject arbitrary text into CSS.
export function normalizeColor(value: string | null | undefined): string {
  if (typeof value !== "string" || !HEX.test(value.trim())) return DEFAULT_ACCENT;
  return value.trim().toLowerCase();
}

/// Returns an error message, or null when the name is usable. No
/// extension is required: Cursor's legacy .cursorrules has none.
export function validateAgentFileName(name: string): string | null {
  if (!name.trim()) return "Enter a file name.";
  if (name.includes("/") || name.includes("\\")) return "Must be a file name, not a path.";
  return null;
}

export type RenameDecision = "prompt" | "point" | "error";

/// The spec's §6 table, as a function. "prompt" means ask before moving;
/// "point" means just record the new name; "error" means reject.
export function renameDecision(
  oldName: string,
  newName: string,
  oldExists: boolean,
  targetExists: boolean
): RenameDecision {
  if (validateAgentFileName(newName)) return "error";
  if (newName === oldName) return "point";
  if (oldExists && !targetExists) return "prompt";
  return "point";
}

export interface ResolvedAgent {
  profileId: string;
  file: string;
  command: string;
  mcpSupported: boolean;
}

const FALLBACK_PROFILE = "claude-code";

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/// Explicit config beats the profile default beats claude-code's default
/// (spec §4.2). Expressed once so the panel, the hub label, the home tile
/// and the agent-file view can never disagree.
export function resolveAgentConfig(
  config: AgentConfig | null | undefined,
  profiles: AgentProfileInfo[]
): ResolvedAgent {
  const requested = nonEmpty(config?.profile) ?? FALLBACK_PROFILE;
  const profile = profiles.find((p) => p.id === requested);
  const fallback = profiles.find((p) => p.id === FALLBACK_PROFILE);
  const effective = profile ?? fallback;
  return {
    profileId: effective?.id ?? FALLBACK_PROFILE,
    // `custom` carries empty defaults, so an unfilled custom profile still
    // resolves to something openable rather than an empty path.
    file:
      nonEmpty(config?.file) ??
      nonEmpty(effective?.instructionsFile) ??
      nonEmpty(fallback?.instructionsFile) ??
      "CLAUDE.md",
    command:
      nonEmpty(config?.command) ??
      nonEmpty(effective?.command) ??
      nonEmpty(fallback?.command) ??
      "claude",
    mcpSupported: effective?.mcpSupported ?? false,
  };
}

/// The CSS custom-property value for a workspace accent, or `undefined`
/// when none is set. Undefined is load-bearing twice over: it lets each
/// indicator keep its OWN default (the hub nav's amber, a pane tab's
/// blue), and it stops an uncoloured sidebar row from inheriting the
/// active workspace's accent from an ancestor.
export function accentVar(color: string | null | undefined): string | undefined {
  return typeof color === "string" && color.trim() ? normalizeColor(color) : undefined;
}
