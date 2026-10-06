// The Agents settings hub: one top-level Settings section with a General
// tab plus one tab per agent (built-ins, then app-wide customs, then
// workspace locals marked). Shared by the app-wide page, the workspace
// Settings tab, and Companion.
//
// Search still hides whole SECTIONS (settingsSearch.ts). One `agents`
// entry carries every keyword the old panes claimed. Which INNER tab
// opens is a local choice; when search just revealed the section,
// `agentsTabForQuery` picks General or the best agent tab.

import {
  COMPLEXITY_LEVELS,
  type AgentDefaults,
  type ComplexityTable,
  type CustomProfile,
} from "$lib/cards/complexity";
import type { AgentProfileInfo } from "$lib/core/settings";
import type { SettingsSection } from "$lib/core/settingsSearch";
import type { Workspace } from "$lib/core/workspace";
import type { WorkspaceSettingsPatch } from "$lib/workspace/workspaceSettings";

export type AgentsHubScope = "app" | "workspace";

/// `"general"` or a profile id (built-in or custom).
export type AgentsHubTab = "general" | (string & {});

export interface AgentsHubTabDef {
  id: AgentsHubTab;
  label: string;
  /// Shown in a tooltip on the tab's button (the "+" tab's explanation).
  hint?: string;
}

export const GENERAL_TAB: AgentsHubTab = "general";

/// The trailing "+" tab: it opens the add-a-custom form instead of an
/// agent's settings. A real tab id so selection, keyboard focus and the
/// strip's `aria-selected` all work unchanged; never a profile id (those
/// are slugs, optionally `local:`-prefixed).
export const ADD_TAB: AgentsHubTab = "+";

/// What the "+" tab says on hover, per scope.
export const ADD_TAB_HINT: Record<AgentsHubScope, string> = {
  app: "Add a custom agent. Each custom gets its own tab for command, flags, API family, fallback, complexity, pause and prompt lines.",
  workspace:
    "Add a local custom agent. Locals are marked on their tabs and only exist in this workspace.",
};

export const GENERAL_TAB_DEF: AgentsHubTabDef = { id: GENERAL_TAB, label: "General" };

/// Keywords for the single top-level Agents section. First entry is the
/// nav label (`sectionLabel` takes keywords[0]).
export const AGENTS_SECTION_KEYWORDS: readonly string[] = [
  "Agents",
  "General",
  "Default agent",
  "Defaults",
  "Customs",
  "This agent",
  "Complexity",
  "Fallback",
  "Pause",
  "Agent defaults",
  "Custom agent",
  "custom profiles",
  "named custom",
  "Command",
  "Model flag",
  "Effort flag",
  "API family",
  "model",
  "effort",
  "reasoning",
  "thinking",
  "Claude Code",
  "Codex",
  "difficulty",
  "Fallback agent",
  "fallback chain",
  "usage limit",
  "quota",
  "rate limit",
  "arm",
  "Agent pause",
  "Add custom",
  "New custom",
  "Prompt lines",
  "Prompt params",
  "Extra prompt",
  "CLI args",
  "CLI arguments",
  "Extra arguments",
  "cycle",
  "schedule",
  "usage",
  "Profile",
  "Agent file",
  "PRD file",
  "MCP config",
  "MCP format",
  "Superpowers",
];

export const AGENTS_SECTION: SettingsSection = {
  id: "agents",
  keywords: [...AGENTS_SECTION_KEYWORDS],
};

const STOCK_IDS = new Set(["claude-code", "codex", "gemini", "cursor", "opencode"]);

export function isStockProfileId(id: string): boolean {
  return STOCK_IDS.has(id);
}

/// True when the id is a named custom (app-wide or `local:`), not a
/// built-in. Replaces the old `profileId === "custom"` checks.
export function isCustomProfileId(id: string): boolean {
  return Boolean(id) && id !== GENERAL_TAB && id !== ADD_TAB && !isStockProfileId(id);
}

/// Label for a profile picker option. Locals are marked so a workspace
/// list of built-ins ∪ app-wide ∪ locals stays readable.
export function profileOptionLabel(profile: { label: string; local?: boolean }): string {
  return profile.local ? `${profile.label} (local)` : profile.label;
}

/// General + one tab per agent, in merge order (built-ins, app customs,
/// workspace locals), then — when `addHint` is given — the trailing "+"
/// tab. Locals are marked in the tab label.
export function agentsHubTabs(
  profiles: readonly AgentProfileInfo[],
  addHint?: string
): AgentsHubTabDef[] {
  return [
    GENERAL_TAB_DEF,
    ...profiles.map((p) => ({
      id: p.id as AgentsHubTab,
      label: profileOptionLabel(p),
    })),
    ...(addHint === undefined ? [] : [{ id: ADD_TAB, label: "+", hint: addHint }]),
  ];
}

/// The tab a surface should keep showing after the profile list changed
/// under it: General, the "+" tab and any profile that still exists stay;
/// a tab whose agent was deleted (or never loaded) falls back to General.
export function validAgentsTab(
  tab: AgentsHubTab,
  profiles: readonly AgentProfileInfo[],
  hasAddTab: boolean
): AgentsHubTab {
  if (tab === GENERAL_TAB) return tab;
  if (tab === ADD_TAB) return hasAddTab ? tab : GENERAL_TAB;
  return profiles.some((p) => p.id === tab) ? tab : GENERAL_TAB;
}

/// Which inner tab a search query should open when the Agents section
/// just became visible. Falls back to General.
export function agentsTabForQuery(
  _scope: AgentsHubScope,
  query: string,
  profiles: readonly AgentProfileInfo[] = []
): AgentsHubTab {
  const q = query.trim().toLowerCase();
  if (!q) return GENERAL_TAB;

  // "add a custom" lands on the trailing "+" tab, which is where the
  // form lives; a bare "customs" query is the same wish.
  if (/\b(add|new|create)\b.*\bcustom/.test(q) || /^customs?$/.test(q)) return ADD_TAB;

  const generalHits = [
    "general",
    "default agent",
    "default",
    "complexity",
    "difficulty",
    "pause",
    "cycle",
    "schedule",
    "this agent",
    "profile",
    "workspace agent",
  ];
  if (generalHits.some((w) => q.includes(w))) return GENERAL_TAB;

  for (const profile of profiles) {
    const hay = `${profile.id} ${profile.label}`.toLowerCase();
    if (q.includes(profile.id.toLowerCase()) || q.includes(profile.label.toLowerCase())) {
      return profile.id;
    }
    if (profile.local && q.includes("local") && hay.includes(q.replace("local", "").trim())) {
      return profile.id;
    }
  }

  const agentHits = [
    "custom",
    "command",
    "model flag",
    "effort flag",
    "api family",
    "named",
    "fallback",
    "arm",
    "usage limit",
    "quota",
    "rate limit",
    "effort",
    "reasoning",
    "thinking",
    "model",
    "mcp",
    "superpowers",
    "agent file",
  ];
  if (agentHits.some((w) => q.includes(w))) {
    // Prefer the first custom when the query is about customs; else first profile.
    if (q.includes("custom") || q.includes("api family") || q.includes("named")) {
      const custom = profiles.find((p) => isCustomProfileId(p.id));
      if (custom) return custom.id;
    }
    return profiles[0]?.id ?? GENERAL_TAB;
  }

  return GENERAL_TAB;
}

/// Slug for a new app-wide custom. Never a stock id; collisions get a
/// numeric suffix.
export function slugifyCustomId(label: string, taken: Iterable<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "custom";
  let candidate = isStockProfileId(base) || base === "custom" ? `${base}-agent` : base;
  const used = new Set(taken);
  if (!used.has(candidate) && !isStockProfileId(candidate)) return candidate;
  let n = 2;
  while (used.has(`${candidate}-${n}`) || isStockProfileId(`${candidate}-${n}`)) n += 1;
  return `${candidate}-${n}`;
}

export function localCustomId(slug: string): string {
  const bare = slug.startsWith("local:") ? slug.slice("local:".length) : slug;
  return `local:${bare}`;
}

export function emptyCustomProfile(id: string, label: string): CustomProfile {
  return { id, label, command: "", modelFlag: "" };
}

export function addCustomProfile(
  list: CustomProfile[],
  label: string,
  opts: { local?: boolean } = {}
): CustomProfile[] {
  const taken = list.map((p) => p.id);
  const slug = slugifyCustomId(label, taken.map((id) => id.replace(/^local:/, "")));
  const id = opts.local ? localCustomId(slug) : slug;
  if (list.some((p) => p.id === id)) return list;
  return [...list, emptyCustomProfile(id, label.trim() || "Custom")];
}

export function updateCustomProfile(
  list: CustomProfile[],
  id: string,
  patch: Partial<Omit<CustomProfile, "id">>
): CustomProfile[] {
  return list.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

export function renameCustomProfile(list: CustomProfile[], id: string, label: string): CustomProfile[] {
  const trimmed = label.trim();
  if (!trimmed) return list;
  return updateCustomProfile(list, id, { label: trimmed });
}

export function deleteCustomProfile(list: CustomProfile[], id: string): CustomProfile[] {
  return list.filter((p) => p.id !== id);
}

/// A chains map with one profile's references removed: its own key, and
/// any chain still naming it as a fallback. Deleting the custom's row
/// alone would leave both dangling — a launch walking the chain would
/// ask to set up an agent that no longer exists.
export function fallbackChainsWithoutProfile(
  map: Record<string, string[]> | null | undefined,
  id: string
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [primary, chain] of Object.entries(map ?? {})) {
    if (primary === id) continue;
    next[primary] = chain.filter((c) => c !== id);
  }
  return next;
}

/// A per-primary map with one profile's own key removed. Used for the
/// pause, prompt-line and CLI-arg maps, whose VALUES never name another
/// profile (unlike the chains and complexity tables).
export function mapWithoutKey<V>(
  map: Record<string, V> | null | undefined,
  id: string
): Record<string, V> {
  const next = { ...(map ?? {}) };
  delete next[id];
  return next;
}

/// A complexity-tables map with one profile's references removed: its own
/// table, and every row of every other table that routes a level to it.
/// A row left pointing at a deleted custom would send those cards to an
/// agent that no longer exists, so they are cleared back to "run the
/// workspace's agent" rather than left dangling.
///
/// `keepEmpty` is for a WORKSPACE map, where a present-but-empty table is
/// a real answer ("no routing for this agent here") and absent means
/// inherit: a table emptied by this cleanup stays as that answer instead
/// of silently reverting to the app-wide table.
export function complexityTablesWithoutProfile(
  map: Record<string, ComplexityTable> | null | undefined,
  id: string,
  keepEmpty = false
): Record<string, ComplexityTable> {
  const next: Record<string, ComplexityTable> = {};
  for (const [primary, table] of Object.entries(map ?? {})) {
    if (primary === id) continue;
    const kept: ComplexityTable = {};
    for (const level of COMPLEXITY_LEVELS) {
      const entry = table[level];
      if (entry && entry.profile.trim() !== id) kept[level] = entry;
    }
    if (keepEmpty || COMPLEXITY_LEVELS.some((level) => kept[level])) next[primary] = kept;
  }
  return next;
}

/// What deleting a WORKSPACE-LOCAL custom must also clear from that
/// workspace's own per-agent settings, as a settings patch (`null` removes
/// a key that ends up empty). Empty when it was referenced nowhere.
///
/// The app-wide delete does this to the defaults in one pass
/// (`agentDefaultsWithoutCustom`); a local lives on the workspace record,
/// so its cleanup is a patch of the workspace's own maps: its fallback
/// chain and any chain naming it, its complexity table and every row
/// routing to it, its pause cycle, prompt lines and CLI arguments.
export function workspacePatchWithoutProfile(
  ws: Pick<
    Workspace,
    "fallbackChains" | "complexityTables" | "pauseCycles" | "promptExtras" | "extraCliArgs"
  >,
  id: string
): WorkspaceSettingsPatch {
  const patch: WorkspaceSettingsPatch = {};
  const orNull = <V>(map: Record<string, V>): Record<string, V> | null =>
    Object.keys(map).length > 0 ? map : null;
  const changed = (before: unknown, after: unknown): boolean =>
    JSON.stringify(before ?? {}) !== JSON.stringify(after ?? {});

  if (ws.fallbackChains) {
    const next = fallbackChainsWithoutProfile(ws.fallbackChains, id);
    if (changed(ws.fallbackChains, next)) patch.fallbackChains = orNull(next);
  }
  if (ws.complexityTables) {
    const next = complexityTablesWithoutProfile(ws.complexityTables, id, true);
    if (changed(ws.complexityTables, next)) patch.complexityTables = orNull(next);
  }
  for (const key of ["pauseCycles", "promptExtras", "extraCliArgs"] as const) {
    const map = ws[key] as Record<string, unknown> | undefined;
    if (map && Object.prototype.hasOwnProperty.call(map, id)) {
      (patch as Record<string, unknown>)[key] = orNull(mapWithoutKey(map, id));
    }
  }
  return patch;
}

/// The app-wide defaults with one custom profile and every reference to
/// it removed: its fallback chain (and any chain naming it), its walk-at
/// threshold, its complexity table (and every row routing to it), pause
/// cycle, prompt lines and CLI args, and a default agent that pointed at
/// it — which goes back to claude-code, the fallback an absent setting
/// already means.
export function agentDefaultsWithoutCustom(defaults: AgentDefaults, id: string): AgentDefaults {
  const fallbackThresholds = { ...(defaults.fallbackThresholds ?? {}) };
  delete fallbackThresholds[id];
  return {
    ...defaults,
    customProfiles: deleteCustomProfile(defaults.customProfiles ?? [], id),
    fallbackChains: fallbackChainsWithoutProfile(defaults.fallbackChains, id),
    fallbackThresholds,
    complexityTables: complexityTablesWithoutProfile(defaults.complexityTables, id),
    pauseCycles: mapWithoutKey(defaults.pauseCycles, id),
    promptExtras: mapWithoutKey(defaults.promptExtras, id),
    extraCliArgs: mapWithoutKey(defaults.extraCliArgs, id),
    defaultAgent: (defaults.defaultAgent ?? "").trim() === id ? "claude-code" : defaults.defaultAgent,
  };
}

/// Profiles the model/effort rows cover: built-ins plus every custom in
/// scope (merged list already carries locals).
export function profilesForDefaults(profiles: AgentProfileInfo[]): AgentProfileInfo[] {
  return profiles;
}

export function effortCapableProfiles(profiles: AgentProfileInfo[]): AgentProfileInfo[] {
  return profiles.filter((p) => Boolean(p.effortFlag?.trim()) || !isStockProfileId(p.id));
}
