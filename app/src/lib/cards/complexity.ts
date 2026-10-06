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
import type { PauseCycle } from "$lib/agents/agentPause";

/// One named custom agent, as config.json stores it. Mirrors
/// `config::CustomProfile`.
export interface CustomProfile {
  id: string;
  label: string;
  command: string;
  modelFlag: string;
  effortFlag?: string;
  apiFamily?: string;
  resumeArgs?: string;
}

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
///
/// `effort` is how hard that agent thinks. Optional because every table
/// and card stored before it existed has none, and absent means the
/// same as empty: whatever effort the agent would otherwise launch at.
export interface ComplexityAgent {
  profile: string;
  model: string;
  effort?: string;
}

/// The stored tables. `Partial` rather than a full record because
/// ABSENCE is the inherit signal at both levels: a level with no entry
/// in the workspace table falls through to the app one, and a level with
/// no entry there runs the workspace's own agent.
export type ComplexityTable = Partial<Record<Complexity, ComplexityAgent>>;

/// Fallback chains keyed by the launch's resolved (primary) profile id.
/// Missing key means pause-only (app) or inherit the app chain (workspace).
export type FallbackChainsByPrimary = Record<string, string[]>;

/// Complexity tables keyed by primary profile id. On the app map a
/// missing key means "no table for that primary"; on a workspace map,
/// missing means inherit the app table for it.
export type ComplexityTablesByPrimary = Record<string, ComplexityTable>;

/// One primary's app-wide table, or an empty one.
export function complexityTableForPrimary(
  map: ComplexityTablesByPrimary | null | undefined,
  primaryId: string
): ComplexityTable {
  const id = (primaryId ?? "").trim();
  // Own keys only: a custom whose slug is `constructor` must not find
  // Object.prototype's.
  return id && map && Object.prototype.hasOwnProperty.call(map, id) ? (map[id] ?? {}) : {};
}

/// The table that governs a launch on `primaryId` in this workspace: the
/// workspace's own table when its map has the key, else the app's.
export function effectiveComplexityTable(
  workspaceMap: ComplexityTablesByPrimary | null | undefined,
  appMap: ComplexityTablesByPrimary | null | undefined,
  primaryId: string
): ComplexityTable {
  const id = (primaryId ?? "").trim();
  if (!id) return {};
  if (workspaceMap != null && Object.prototype.hasOwnProperty.call(workspaceMap, id)) {
    return workspaceMap[id];
  }
  return complexityTableForPrimary(appMap, id);
}

/// Copy of `map` with one primary's table set, or the key removed.
///
/// An EMPTY table is stored as absent by default, so "nothing to say" and
/// "never touched" look alike on disk in the app-wide map. A workspace map
/// passes `keepEmpty`: there absent means INHERIT, so an own table with no
/// rows is a real answer ("no routing for this agent here") that must not
/// collapse back into inheriting.
export function withComplexityTableForPrimary(
  map: ComplexityTablesByPrimary | null | undefined,
  primaryId: string,
  table: ComplexityTable | null,
  keepEmpty = false
): ComplexityTablesByPrimary {
  const id = (primaryId ?? "").trim();
  const next: ComplexityTablesByPrimary = { ...(map ?? {}) };
  if (!id) return next;
  const has = COMPLEXITY_LEVELS.some((level) => isAttributed(table?.[level]));
  if (table && (has || keepEmpty)) next[id] = table;
  else delete next[id];
  return next;
}

/// The app-wide agent defaults, as config.json stores them. Mirrors
/// `config::AgentDefaultsConfig`.
export interface AgentDefaults {
  /// Named app-wide custom agent profiles. Empty is the shipped state.
  customProfiles?: CustomProfile[];
  /// The app-wide default agent: the profile a workspace with no
  /// `[agent] profile` of its own resolves to. The stored Option is
  /// resolved at the boundary (`EMPTY_AGENT_DEFAULTS` spreads in
  /// "claude-code", the hard-coded fallback every older build used), so
  /// this is always a usable id here.
  defaultAgent: string;
  /// Legacy single-custom fields — kept optional so older fixtures and
  /// the Settings UI that still edits them compile during the transition.
  /** @deprecated Prefer `customProfiles`. */
  customCommand?: string;
  /** @deprecated Prefer `customProfiles`. */
  customModelFlag?: string;
  /** @deprecated Prefer `customProfiles`. */
  customEffortFlag?: string;
  /// The app-wide default effort per profile id, beside the default model
  /// (`agentModelDefaultsStore`). Absent key means the agent's own default.
  /// Here rather than a Tauri command of its own, so it rides the same
  /// wholesale `setAgentDefaults` save as the complexity table.
  agentEfforts?: Record<string, string>;
  /** @deprecated Prefer `customProfiles[].apiFamily`. */
  customApiFamily?: string;
  /// Complexity tables keyed by primary profile id (`complexityTables`).
  /// A primary with no table runs the workspace's agent at every level.
  complexityTables: ComplexityTablesByPrimary;
  /// App-wide pause cycles keyed by primary profile id (`pauseCycles`).
  /// A primary with no cycle is never held.
  pauseCycles: Record<string, PauseCycle>;
  /// Extra prompt-text lines appended to prompts composed for each
  /// primary (`promptExtras`), and extra CLI arguments appended to each
  /// primary's launch command (`extraCliArgs`).
  promptExtras: Record<string, string[]>;
  extraCliArgs: Record<string, string[]>;
  /// App-wide fallback chains keyed by primary profile id. Empty map /
  /// missing primary means pause-only for that primary.
  fallbackChains: FallbackChainsByPrimary;
  /// Per-profile percent at which a new launch walks away. Missing key
  /// means 90. Resume still uses the pause cycle's limitPercent.
  fallbackThresholds: Record<string, number>;
  /// App-wide overrides of shipped agent action prompts, keyed by catalog
  /// id (`action:run-task`, `builtin:commit`, …). Empty means every prompt
  /// uses its default; a workspace map on `Workspace.actionPromptOverrides`
  /// wins per id. Lives here so it rides `setAgentDefaults` rather than a
  /// new persist_workspaces positional.
  actionPromptOverrides: Record<string, string>;
}

export const EMPTY_AGENT_DEFAULTS: AgentDefaults = {
  customProfiles: [],
  defaultAgent: "claude-code",
  complexityTables: {},
  pauseCycles: {},
  promptExtras: {},
  extraCliArgs: {},
  fallbackChains: {},
  fallbackThresholds: {},
  actionPromptOverrides: {},
};

/// The profile id a profile-less workspace resolves to: the configured
/// default agent, or "claude-code" while it is empty.
export function effectiveDefaultAgent(defaults: AgentDefaults | null | undefined): string {
  const id = (defaults?.defaultAgent ?? "").trim();
  return id || "claude-code";
}

/// The app-wide defaults with one profile's default effort set, or
/// removed when `effort` is blank -- removing rather than storing "" for
/// `setAgentModelDefault`'s reason: the picker's inherit row has to be
/// able to UNDO a default. Never mutates `defaults`.
export function withAgentEffort(
  defaults: AgentDefaults,
  profileId: string,
  effort: string
): AgentDefaults {
  const agentEfforts = { ...(defaults.agentEfforts ?? {}) };
  const chosen = effort.trim();
  if (chosen) agentEfforts[profileId] = chosen;
  else delete agentEfforts[profileId];
  return { ...defaults, agentEfforts };
}

/// Whether an entry says anything at all. A row with nothing filled in is
/// not stored: it would be indistinguishable from "inherit" when read
/// back, and storing it would make the workspace table shadow the app one
/// with nothing. An effort alone IS something -- "this workspace's agent,
/// thinking harder" is the whole row for a hard level on a one-CLI
/// machine.
export function isAttributed(entry: ComplexityAgent | undefined | null): boolean {
  return Boolean(
    entry && (entry.profile.trim() || entry.model.trim() || (entry.effort ?? "").trim())
  );
}

/// The entry that governs one level in ONE table: the level's own entry
/// if it says anything, else null (run the workspace's agent). Which table
/// is "the" table — the effective per-primary one — is the caller's
/// question (`effectiveComplexityTable`).
export function complexityEntryFor(
  level: Complexity | null | undefined,
  table: ComplexityTable
): ComplexityAgent | null {
  if (!level) return null;
  const entry = table[level];
  return isAttributed(entry) ? (entry as ComplexityAgent) : null;
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
  const effort = (entry.effort ?? "").trim() || null;
  if (!profile) {
    // No profile: everything about the workspace's agent survives,
    // because it really is the same agent -- including whichever of
    // model and effort the attribution leaves empty. A row that says only
    // "max effort" must not also drop the workspace's pinned model back
    // to the app-wide default.
    const own = base ?? { profile: null, file: null, command: null };
    return { ...own, model: model ?? own.model ?? null, effort: effort ?? own.effort ?? null };
  }
  const sameProfile = (base?.profile ?? "").trim() === profile;
  if (!sameProfile) {
    return { profile, file: null, command: null, mcpFile: null, mcpFormat: null, model, effort };
  }
  return { ...(base ?? { profile, file: null, command: null }), profile, model, effort };
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
  const at = effortPhrase(entry);
  if (agent && model) return `${name} — runs ${agent} on ${model}${at}.`;
  if (agent) return `${name} — runs ${agent}${at}.`;
  if (model) return `${name} — runs this workspace's agent on ${model}${at}.`;
  return `${name} — runs this workspace's agent${at}.`;
}

/// ", at max effort" for an attribution that names one, "" otherwise --
/// the tail every one-phrase description of an attribution shares, so a
/// caller can append it unconditionally.
export function effortPhrase(entry: { effort?: string | null } | null | undefined): string {
  const effort = (entry?.effort ?? "").trim();
  return effort ? `, at ${effort} effort` : "";
}

/// Whether two tables say the same thing at every level. Lets a caller
/// that is about to WRITE a table skip the write when nothing changed --
/// writing an unchanged EFFECTIVE table into a workspace would freeze the
/// app-wide one into it, turning "inherit" into a copy that stops
/// following the app.
export function sameComplexityTable(a: ComplexityTable, b: ComplexityTable): boolean {
  return COMPLEXITY_LEVELS.every((level) => {
    const x = a[level];
    const y = b[level];
    if (!isAttributed(x) && !isAttributed(y)) return true;
    if (!x || !y) return false;
    return (
      x.profile.trim() === y.profile.trim() &&
      x.model.trim() === y.model.trim() &&
      (x.effort ?? "").trim() === (y.effort ?? "").trim()
    );
  });
}

/// What the agent-change confirm wizard does to the complexity table of
/// the agent being switched TO (the one that will govern this workspace)
/// before the new profile is written.
export type ComplexityRealignAction = "keep" | "remap" | "clear";

/// Apply one realign choice. Never mutates `table`.
///
/// - `keep` — leave the table as it is.
/// - `remap` — rows whose profile names `oldProfile` are retargeted to
///   `newProfile`; models and other rows stay. (Written into the workspace
///   as a table of its own for the new agent.)
/// - `clear` — empty the table. The caller turns that into "this
///   workspace keeps no table of its own for the new agent", which hands
///   it back to the app-wide one.
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

/// Default choice for the wizard: always `keep`.
///
/// Complexity tables are per agent now, so a level left alone in the new
/// agent's table runs THAT agent -- "this workspace's agent" can no longer
/// go stale across a switch, which is what recommending `clear` used to
/// guard against. And a row in the new agent's table that names the agent
/// being left is as likely a deliberate cross-agent route ("on codex, send
/// the hard ones to claude") as a leftover, so rewriting it, or dropping
/// the whole table, is a choice for the human to make, not a default. The
/// arguments stay so the wizard's call site reads the same either way.
export function recommendedComplexityAction(
  _table: ComplexityTable,
  _oldProfile: string
): ComplexityRealignAction {
  return "keep";
}
