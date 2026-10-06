// The Agents settings hub: one top-level Settings section with a General
// tab plus one tab per agent (built-ins, then app-wide customs, then
// workspace locals marked). Shared by the app-wide page, the workspace
// Settings tab, and Companion.
//
// Search still hides whole SECTIONS (settingsSearch.ts). One `agents`
// entry carries every keyword the old panes claimed. Which INNER tab
// opens is a local choice; when search just revealed the section,
// `agentsTabForQuery` picks General or the best agent tab.

import type { AgentDefaults, CustomProfile } from "$lib/cards/complexity";
import type { AgentProfileInfo } from "$lib/core/settings";
import type { SettingsSection } from "$lib/core/settingsSearch";

export type AgentsHubScope = "app" | "workspace";

/// `"general"` or a profile id (built-in or custom).
export type AgentsHubTab = "general" | (string & {});

export interface AgentsHubTabDef {
  id: AgentsHubTab;
  label: string;
}

export const GENERAL_TAB: AgentsHubTab = "general";

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
  "cycle",
  "schedule",
  "usage",
  "Profile",
  "Agent file",
  "PRD file",
  "MCP config",
  "MCP format",
  "Matt Pocock's skills",
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
  return Boolean(id) && id !== GENERAL_TAB && !isStockProfileId(id);
}

/// Label for a profile picker option. Locals are marked so a workspace
/// list of built-ins ∪ app-wide ∪ locals stays readable.
export function profileOptionLabel(profile: { label: string; local?: boolean }): string {
  return profile.local ? `${profile.label} (local)` : profile.label;
}

/// General + one tab per agent, in merge order (built-ins, app customs,
/// workspace locals). Locals are marked in the tab label.
export function agentsHubTabs(profiles: readonly AgentProfileInfo[]): AgentsHubTabDef[] {
  return [
    GENERAL_TAB_DEF,
    ...profiles.map((p) => ({
      id: p.id as AgentsHubTab,
      label: profileOptionLabel(p),
    })),
  ];
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
    "pocock",
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

/// The app-wide defaults with one custom profile and every reference to
/// it removed: its fallback chain (and any chain naming it), its walk-at
/// threshold, and a default agent that pointed at it — which goes back
/// to claude-code, the fallback an absent setting already means.
export function agentDefaultsWithoutCustom(defaults: AgentDefaults, id: string): AgentDefaults {
  const fallbackThresholds = { ...(defaults.fallbackThresholds ?? {}) };
  delete fallbackThresholds[id];
  return {
    ...defaults,
    customProfiles: deleteCustomProfile(defaults.customProfiles ?? [], id),
    fallbackChains: fallbackChainsWithoutProfile(defaults.fallbackChains, id),
    fallbackThresholds,
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
