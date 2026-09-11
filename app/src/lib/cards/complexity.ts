/// Card complexity: the five-step scale a card can carry, and the table
/// that turns a level into the agent and model that executes it.
///
/// The whole point of the field is that one card is not worth what
/// another one costs. A rename is not a refactor, and running both on
/// the strongest model available burns a subscription window on work a
/// small model finishes correctly. The scale is about DIFFICULTY --
/// how much reasoning the work needs -- rather than size, because that
/// is the question a model tier actually answers.
///
/// Pure and unit-tested, so every surface that touches it (the card
/// detail modal, the ⌘N composer, both settings panels and every launch
/// route) stays a template over this.

import type { AgentConfig } from "$lib/core/gavin";

/// The five levels, ascending. Mirrors `protocol::Complexity` -- the
/// written names ARE the wire format and the frontmatter value, so a
/// spelling change here is a protocol change.
export const COMPLEXITY_LEVELS = [
  "trivial",
  "simple",
  "moderate",
  "complex",
  "intricate",
] as const;

export type Complexity = (typeof COMPLEXITY_LEVELS)[number];

/// What each level is called on screen, and the one line that says where
/// the boundary is. Descriptions are not decoration: five adjectives on
/// their own are an ordering the human has to guess at, and a table that
/// decides which model runs their work is the wrong place to guess.
export const COMPLEXITY_LABELS: Record<Complexity, { label: string; hint: string }> = {
  trivial: { label: "Trivial", hint: "A one-liner — a rename, a typo, a version bump." },
  simple: { label: "Simple", hint: "One file, one obvious change, nothing to work out." },
  moderate: { label: "Moderate", hint: "A few files and some judgement, but the shape is clear." },
  complex: { label: "Complex", hint: "Cross-cutting work that needs a plan before any code." },
  intricate: { label: "Intricate", hint: "Subtle, risky or unfamiliar — the deep end." },
};

/// Parses a written level, or null. Never falls back to a level: a value
/// gavin cannot read has to mean "unset", which runs the workspace's own
/// agent, rather than silently picking somebody a model. The daemon's
/// `Complexity::parse` takes the same posture and the same spellings.
export function parseComplexity(value: string | null | undefined): Complexity | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (COMPLEXITY_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as Complexity)
    : null;
}

/// The level's display name, or the raw value for something gavin does
/// not recognise -- a hand-edited card should read back as what it says,
/// not as nothing.
export function complexityLabel(value: string | null | undefined): string {
  const level = parseComplexity(value);
  return level ? COMPLEXITY_LABELS[level].label : (value ?? "").trim();
}

/// The sentinel a complexity picker uses for "no level". Never a level
/// name and never written to a card: choosing it CLEARS the frontmatter
/// line, which is why it has to be distinguishable from `trivial` --
/// "nobody said" and "this is easy" pick different agents.
export const NO_COMPLEXITY = "";

/// One level's answer to "which agent, at which model". Mirrors
/// `config::ComplexityAgent` in Rust.
///
/// An empty `profile` is meaningful, not missing: it means this level
/// names only a model, run on whatever profile the workspace already
/// uses. That is the common case on a machine with one CLI installed --
/// "hard cards get opus" -- and making it expressible is what stops the
/// table forcing a profile choice nobody wanted. An empty `model` in
/// turn means that profile's own default.
export interface ComplexityAgent {
  profile: string;
  model: string;
}

/// The stored tables. `Partial` rather than a full record because
/// ABSENCE is the inherit signal at both levels: a level with no entry
/// in the workspace table falls through to the app one, and a level with
/// no entry there runs the workspace's own agent.
export type ComplexityTable = Partial<Record<Complexity, ComplexityAgent>>;

/// The app-wide agent defaults, as config.json stores them. Mirrors
/// `config::AgentDefaultsConfig`.
export interface AgentDefaults {
  /// The command the `custom` profile launches when a workspace on it
  /// names none of its own.
  customCommand: string;
  /// The argv that carries a model into that command. Empty means gavin
  /// has no verified way to put a model on it, and every model control
  /// for `custom` stays hidden rather than guessing a flag.
  customModelFlag: string;
  complexity: ComplexityTable;
  /// App-wide fallback chain. Empty means pause-only when a launch's
  /// resolved agent is over its usage-probe threshold.
  agentFallback: string[];
  /// Per-profile percent at which a new launch walks away. Missing key
  /// means 90. Resume still uses the pause cycle's limitPercent.
  fallbackThresholds: Record<string, number>;
}

export const EMPTY_AGENT_DEFAULTS: AgentDefaults = {
  customCommand: "",
  customModelFlag: "",
  complexity: {},
  agentFallback: [],
  fallbackThresholds: {},
};

/// Whether an entry says anything at all. A row with neither half filled
/// in is not stored: it would be indistinguishable from "inherit" when
/// read back, and storing it would make the workspace table shadow the
/// app one with nothing.
export function isAttributed(entry: ComplexityAgent | undefined | null): boolean {
  return Boolean(entry && (entry.profile.trim() || entry.model.trim()));
}

/// The entry that governs one level: the workspace's own if it says
/// anything, else the app-wide one, else null.
///
/// Per LEVEL rather than per table, deliberately. A workspace that wants
/// its intricate cards on a different agent should not have to restate
/// the other four, and a wholesale override would silently drop the app
/// defaults for every level the workspace left alone.
export function complexityEntry(
  level: Complexity | null | undefined,
  app: ComplexityTable,
  workspace: ComplexityTable
): ComplexityAgent | null {
  if (!level) return null;
  const own = workspace[level];
  if (isAttributed(own)) return own as ComplexityAgent;
  const shared = app[level];
  return isAttributed(shared) ? (shared as ComplexityAgent) : null;
}

/// The agent config an attributed card resolves through: the workspace's
/// own, with the attribution's profile and/or model laid over it.
///
/// Takes any `{profile, model}` pair rather than a level's, because two
/// things now produce one -- the complexity table, and a card's own
/// `agent:`/`model:` lines (cardAgent.ts). They differ only in where the
/// pair came from; laying it over the workspace's config is the same
/// operation, and a second copy of it is how the two answers start
/// resolving by different rules.
///
/// Returns the base UNTOUCHED when the attribution names nothing, which
/// is what makes this safe to put on every launch route -- a workspace
/// with an empty table and unattributed cards behaves exactly as it did
/// before either field existed.
///
/// The overlay follows `candidateAgentConfig`'s rule and for the same
/// reason: `command`, `file`, `mcpFile` and `modelFlag` describe the
/// binary the WORKSPACE chose -- a pinned wrapper script, an absolute
/// path, a hand-written MCP location -- so carrying them onto a
/// DIFFERENT profile is garbage in that profile's argv and a config file
/// written to the wrong place. An attribution that names only a model is
/// therefore the gentle case: same agent, different model. One that
/// names another profile is a clean switch to it.
export function agentConfigWithAttribution(
  base: AgentConfig | null | undefined,
  entry: ComplexityAgent | null
): AgentConfig | null | undefined {
  if (!entry) return base;
  const profile = entry.profile.trim();
  const model = entry.model.trim() || null;
  if (!profile) {
    // Model only: everything about the workspace's agent survives,
    // because it really is the same agent.
    return { ...(base ?? { profile: null, file: null, command: null }), model };
  }
  const sameProfile = (base?.profile ?? "").trim() === profile;
  if (!sameProfile) {
    return { profile, file: null, command: null, mcpFile: null, mcpFormat: null, model };
  }
  return { ...(base ?? { profile, file: null, command: null }), profile, model };
}

/// How the level reads where it has to be said in one phrase -- a
/// tooltip on a board card, a line in a launch error. Null when the card
/// says nothing, so a caller can concatenate unconditionally.
export function complexitySummary(
  level: Complexity | null | undefined,
  entry: ComplexityAgent | null,
  profileLabel: (id: string) => string
): string | null {
  if (!level) return null;
  const name = COMPLEXITY_LABELS[level].label;
  if (!entry) return `${name} — runs this workspace's agent.`;
  const agent = entry.profile.trim() ? profileLabel(entry.profile.trim()) : null;
  const model = entry.model.trim();
  if (agent && model) return `${name} — runs ${agent} on ${model}.`;
  if (agent) return `${name} — runs ${agent}.`;
  return `${name} — runs this workspace's agent on ${model}.`;
}

/// What the agent-change confirm wizard does to the workspace complexity
/// table before the new profile is written.
export type ComplexityRealignAction = "keep" | "remap" | "clear";

/// Apply one realign choice. Never mutates `table`.
///
/// - `keep` — leave every override alone (app pins still fall through
///   for unset levels).
/// - `remap` — rows whose profile names `oldProfile` are retargeted to
///   `newProfile`; models and other rows stay.
/// - `clear` — drop every workspace override so unset levels mean the
///   new workspace agent (still falling through to app pins).
export function realignComplexityTable(
  table: ComplexityTable,
  action: ComplexityRealignAction,
  oldProfile: string,
  newProfile: string
): ComplexityTable {
  if (action === "keep") return { ...table };
  if (action === "clear") return {};
  const old = oldProfile.trim();
  const next: ComplexityTable = {};
  for (const level of COMPLEXITY_LEVELS) {
    const entry = table[level];
    if (!entry) continue;
    if (entry.profile.trim() === old) {
      next[level] = { ...entry, profile: newProfile };
    } else {
      next[level] = { ...entry };
    }
  }
  return next;
}

/// Default choice for the wizard: remap when any workspace row already
/// names the profile being left, otherwise clear so "this workspace's
/// agent" stops lying after the switch.
export function recommendedComplexityAction(
  table: ComplexityTable,
  oldProfile: string
): ComplexityRealignAction {
  const old = oldProfile.trim();
  for (const level of COMPLEXITY_LEVELS) {
    const entry = table[level];
    if (entry && entry.profile.trim() === old) return "remap";
  }
  return "clear";
}
