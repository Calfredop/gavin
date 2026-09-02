import { composeLaunchCommand } from "./agentModel";
import type { FailureCausePattern } from "./autoResume";
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
  /// The flag that selects a model, e.g. `--model`. Empty where the CLI
  /// takes none, which is how both settings panels decide whether to
  /// offer a model control for this profile at all.
  modelFlag: string;
  /// Stable model aliases offered as picks; empty where the CLI has none
  /// worth pinning, and the user types their own instead.
  models: string[];
  /// What this agent prints when it has STOPPED because something broke.
  /// Empty where nobody has verified the text -- which reads as no
  /// failure detection, never as "nothing failed"
  /// (agent_setup.rs's failure_patterns).
  failurePatterns: string[];
  /// What each of those failures MEANS, in the profile's own order (see
  /// agent_setup.rs's failure_causes). Read only by the auto-resume
  /// trigger table, which needs "broke HOW" rather than "broke": a dead
  /// network and an expired token want opposite answers. Empty means
  /// every failure of this profile classifies as unknown, which never
  /// resumes itself.
  failureCauses: FailureCausePattern[];
  /// Conversation resume: the argv that fixes a session id at launch and
  /// the one that reopens it. Both empty unless BOTH are verified.
  sessionIdArgs: string;
  resumeArgs: string;
  /// How gavin reads this agent's subscription limits ("anthropic-oauth",
  /// "codex-rollout"), or null where it cannot -- which is three of the
  /// five profiles and is a sentence the usage panel prints, not a bar it
  /// leaves empty. See agent_setup.rs's usage_probe for what was checked.
  usageProbe: string | null;
}

/// Mirrors McpFormatDto from agent_setup.rs, for the `custom` profile's
/// dialect picker.
export interface McpFormatInfo {
  id: string;
  label: string;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

/// Mirrors protocol::DEFAULT_PRD_PATH. The path `init_gavin_root`
/// scaffolds, and therefore the answer for every workspace gavin created
/// itself; a project that already had a PRD points `prd` at its own.
export const DEFAULT_PRD_PATH = ".gavin-root/PRD.md";

/// Returns an error message, or null when the path is usable. Mirrors
/// protocol::usable_prd_path, which is the authority -- without this the
/// picker would offer a path the daemon then refuses, and the failure
/// would surface as a request error rather than as a message beside the
/// field. A subpath IS allowed, unlike the agent file: an existing
/// project's PRD usually lives under `docs/`.
export function validatePrdPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a file path.";
  if (trimmed.startsWith("/") || /^[a-z]:[\\/]/i.test(trimmed)) {
    return "Must be inside the root, not an absolute path.";
  }
  if (trimmed.split(/[\\/]/).some((part) => part === ".." || part === ".")) {
    return "Must stay inside the root — no “.” or “..” segments.";
  }
  return null;
}

/// Which file leads this workspace: the root context's configured `prd`,
/// else the scaffolded default. Expressed once so the hub tab, the home
/// excerpt, the wizard and the settings row can never disagree -- and so
/// an older daemon, whose tree carries no `prd` at all, lands on the same
/// branch as a workspace that never chose one.
export function resolvePrdPath(context: { prd?: string | null } | null | undefined): string {
  return nonEmpty(context?.prd) ?? DEFAULT_PRD_PATH;
}

/// A file the user picked in the OS dialog, as a path relative to the
/// workspace root -- or the reason it cannot be used. Both pickers go
/// through here: the dialog hands back an absolute path, and everything
/// gavin stores about these two files is relative to the root so the
/// config stays portable between machines and checkouts.
export function relativeToRoot(
  root: string,
  picked: string
): { path: string } | { error: string } {
  // Windows accepts forward slashes, so normalising to them costs
  // nothing and lets one comparison serve both platforms.
  const slash = (v: string) => v.replace(/\\/g, "/");
  const base = slash(root).replace(/\/+$/, "");
  const target = slash(picked);
  // The trailing slash is load-bearing: without it a sibling directory
  // that merely starts with the root's name (/a/proj-old beside /a/proj)
  // would read as inside it.
  if (!base || !target.startsWith(`${base}/`)) {
    return { error: "Pick a file inside the workspace root." };
  }
  const rest = target.slice(base.length + 1);
  if (!rest) return { error: "Pick a file inside the workspace root." };
  return { path: rest };
}

/// The agent instructions file a pick resolves to. Stricter than the PRD
/// on purpose: the agent CLIs read this file from the repo root by name,
/// so one in a subdirectory would be recorded, opened in the tab, and
/// never actually read by the agent.
export function agentFileFromPick(
  root: string,
  picked: string
): { file: string } | { error: string } {
  const relative = relativeToRoot(root, picked);
  if ("error" in relative) return relative;
  if (relative.path.includes("/")) {
    return { error: "The agent file has to sit in the workspace root, not in a subfolder." };
  }
  return { file: relative.path };
}

/// The PRD path a pick resolves to, or the reason it cannot be used. The
/// pair -- inside the root, then a path the daemon will accept -- runs in
/// the same order on every surface that can repoint the PRD, so it is
/// expressed once here rather than re-sequenced beside each dialog: the
/// PRD tab's strip, the Settings row, and the wizard's PRD step.
export function prdPathFromPick(
  root: string,
  picked: string
): { path: string } | { error: string } {
  const relative = relativeToRoot(root, picked);
  if ("error" in relative) return relative;
  const problem = validatePrdPath(relative.path);
  return problem ? { error: problem } : relative;
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
  /// The model this workspace launches with: its own `[agent] model`,
  /// else the app-wide default for the RESOLVED profile, else "".
  model: string;
  /// `command` with the model flag composed on. What every LAUNCHER
  /// uses. `command` above stays the raw configured value, because that
  /// is what the settings box edits and writes back to config.toml -- a
  /// flag folded into it would be persisted and then appended again.
  launchCommand: string;
  /// What this agent prints when it has stopped because something BROKE.
  /// Handed to the daemon per session, which matches them against the
  /// rendered screen. Empty means NO failure detection for this
  /// workspace's agent -- never "nothing failed".
  failurePatterns: string[];
  /// What each of those failures means, for the auto-resume trigger
  /// table. Travels with the patterns and under the same posture: a
  /// profile that verified neither classifies every failure as unknown,
  /// and unknown never resumes itself.
  failureCauses: FailureCausePattern[];
  /// The argv that fixes a conversation id at launch, and the one that
  /// reopens it. Both empty unless the profile verified BOTH, because
  /// resuming by an id gavin never fixed is a fresh conversation wearing
  /// a better name. Empty leaves conversation resume off and the written
  /// reconstruction (`composeResumeTaskPrompt`) in its place.
  sessionIdArgs: string;
  resumeArgs: string;
}

const FALLBACK_PROFILE = "claude-code";

/// Explicit config beats the profile default beats claude-code's default
/// (spec §4.2). Expressed once so the panel, the hub label, the home tile
/// and the agent-file view can never disagree.
export function resolveAgentConfig(
  config: AgentConfig | null | undefined,
  profiles: AgentProfileInfo[],
  /// The app-wide default model per profile id (config.json). Required
  /// rather than defaulted, so the compiler names every call site
  /// instead of letting one silently stop inheriting.
  globalModels: Record<string, string>
): ResolvedAgent {
  const requested = nonEmpty(config?.profile) ?? FALLBACK_PROFILE;
  const configured = nonEmpty(config?.mcpFile);
  const customMcpFile = configured && !validateMcpConfigPath(configured) ? configured : null;
  const profile = profiles.find((p) => p.id === requested);
  const fallback = profiles.find((p) => p.id === FALLBACK_PROFILE);
  const effective = profile ?? fallback;
  const profileId = effective?.id ?? FALLBACK_PROFILE;
  const command =
    nonEmpty(config?.command) ??
    nonEmpty(effective?.command) ??
    nonEmpty(fallback?.command) ??
    "claude";
  // Keyed by the RESOLVED profile, not the requested one: a config
  // naming a profile that no longer exists runs claude-code, so it must
  // inherit claude-code's default rather than a dead row's.
  const model = nonEmpty(config?.model) ?? nonEmpty(globalModels[profileId]) ?? "";
  return {
    profileId,
    model,
    launchCommand: composeLaunchCommand(command, effective?.modelFlag ?? "", model),
    // `custom` carries empty defaults, so an unfilled custom profile still
    // resolves to something openable rather than an empty path.
    file:
      nonEmpty(config?.file) ??
      nonEmpty(effective?.instructionsFile) ??
      nonEmpty(fallback?.instructionsFile) ??
      "CLAUDE.md",
    command,
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
    // Same posture as headlessArgs, and for the same reason: these three
    // describe the BINARY. Claude Code's `--session-id` on somebody
    // else's agent is garbage in its argv, and its error text on
    // somebody else's screen would paint healthy sessions as broken. A
    // config that OVERRIDES `command` keeps them, deliberately -- the
    // override is nearly always a wrapper or an absolute path to the
    // same binary, and the alternative is losing failure detection for
    // everyone who pins a path.
    failurePatterns: effective?.failurePatterns ?? [],
    failureCauses: effective?.failureCauses ?? [],
    sessionIdArgs: effective?.sessionIdArgs ?? "",
    resumeArgs: effective?.resumeArgs ?? "",
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
