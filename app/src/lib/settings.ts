import type { AgentConfig } from "./gavin";
import type { EffectiveTheme } from "./ui/theme";

/// Mirrors AgentProfileDto from agent_setup.rs, fetched via
/// backend.agentProfiles(). Never duplicated as a literal table here --
/// Rust is the single source of truth.
export interface AgentProfileInfo {
  id: string;
  label: string;
  instructionsFile: string;
  command: string;
  mcpSupported: boolean;
  /// The file this profile's agent reads MCP config from, so copy can name
  /// it. Empty for `custom`, whose path comes from config.toml.
  mcpConfigFile: string;
  /// Whether the agent takes a positional prompt argument; gates the
  /// wizard's agent-driven flows (spec §7.2).
  promptArg: boolean;
  /// The argv for a one-shot run with no TUI, empty where unverified;
  /// gates every hidden background run (agent_setup.rs's headless_args).
  headlessArgs: string;
}

/// Mirrors McpFormatDto from agent_setup.rs, for the `custom` profile's
/// dialect picker.
export interface McpFormatInfo {
  id: string;
  label: string;
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

/// Returns an error message, or null when the path is usable. Mirrors
/// usable_mcp_path in agent_setup.rs, which is the authority: without
/// this the panel would offer to write a file Rust then refuses, and the
/// integration run would silently report MCP config as skipped instead.
/// A subpath IS allowed here, unlike the agent file — an MCP config
/// usually lives in a dot-directory.
export function validateMcpConfigPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a file path.";
  if (trimmed.startsWith("/") || /^[a-z]:[\\/]/i.test(trimmed)) {
    return "Must be inside the root, not an absolute path.";
  }
  if (trimmed.split(/[\\/]/).some((part) => part === "..")) {
    return "Must stay inside the root — no “..” segments.";
  }
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
  headlessArgs: string;
  /// The MCP config file gavin would write for this workspace, or "" when
  /// there is none to write -- which is only ever an unconfigured
  /// `custom` profile.
  mcpConfigFile: string;
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
  const configured = nonEmpty(config?.mcpFile);
  const customMcpFile = configured && !validateMcpConfigPath(configured) ? configured : null;
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
    // `custom` has no row in the table to carry a layout, so its support
    // follows from whether someone has named a USABLE file for it -- the
    // same resolution order as every other field, config over profile. A
    // path Rust would refuse counts as no path, so the panel never offers
    // a write that cannot happen.
    mcpSupported: Boolean(effective?.mcpSupported || customMcpFile),
    mcpConfigFile: nonEmpty(effective?.mcpConfigFile) ?? customMcpFile ?? "",
    // No fallback chain, unlike file/command: this argv describes the
    // BINARY, and claude-code's flags on someone else's agent would be
    // garbage in its argv. Empty means "no headless run offered", the
    // same posture mcpSupported takes.
    headlessArgs: effective?.headlessArgs ?? "",
  };
}

/// The CSS custom-property value for a workspace accent, or `undefined`
/// when none is set. Undefined is load-bearing twice over: it lets each
/// indicator keep its OWN default (the hub nav's amber, a pane tab's
/// blue), and it stops an uncoloured sidebar row from inheriting the
/// active workspace's accent from an ancestor.
/// WCAG's non-text contrast floor. The accent renders as thin indicators
/// -- a 3px sidebar stripe, a 2px tab underline -- so this is the bar
/// that matters, not the 4.5:1 text bar.
const MIN_CONTRAST_ON_LIGHT = 3;

function channelLuminance(v: number): number {
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * channelLuminance(r / 255) +
    0.7152 * channelLuminance(g / 255) +
    0.0722 * channelLuminance(b / 255)
  );
}

/// Scales a colour toward black until it clears the contrast floor against
/// white. Scaling all three channels by the same factor preserves the hue
/// and the ratios between channels, so a swatch stays recognisably itself
/// -- #fbbf24 becomes a darker gold, not a grey.
///
/// Applied to ANY colour rather than looked up in a table of the eight
/// presets, so a hand-edited config.json gets the same treatment. The
/// eight presets were chosen against the #1e1e1e chrome and score
/// 6.0-10.0 there; on white they score 1.7-2.8, which is why this exists.
function darkenForLightSurface(hex: string): string {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const contrast = () => 1.05 / (relativeLuminance(r, g, b) + 0.05);
  // Multiplicative decay, floored so a near-black input terminates.
  for (let i = 0; i < 100 && contrast() < MIN_CONTRAST_ON_LIGHT; i++) {
    [r, g, b] = [r * 0.97, g * 0.97, b * 0.97];
  }
  const hx = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/// The workspace accent, resolved for the theme it will be drawn on.
/// Dark is returned untouched: the presets were picked for that chrome and
/// already read well there, so a user's existing choice looks exactly as it
/// always has.
export function accentVar(
  color: string | null | undefined,
  theme: EffectiveTheme = "dark"
): string | undefined {
  if (typeof color !== "string" || !color.trim()) return undefined;
  const normalized = normalizeColor(color);
  return theme === "light" ? darkenForLightSurface(normalized) : normalized;
}
