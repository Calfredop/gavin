// The Agents settings hub: one top-level Settings section with inner
// tabs, shared by the app-wide page and the workspace Settings tab.
//
// Search still hides whole SECTIONS (settingsSearch.ts). The old
// agent-defaults / custom-agent / complexity / fallback-agent /
// agent-pause ids are gone — one `agents` entry carries every keyword
// those panes used to claim, so a query for "quota" or "API family"
// still lands here. Which INNER tab opens is a local choice; when search
// just revealed the section, `agentsTabForQuery` picks the best tab.

import type { CustomProfile } from "$lib/cards/complexity";
import type { AgentProfileInfo } from "$lib/core/settings";
import type { SettingsSection } from "$lib/core/settingsSearch";

export type AgentsHubScope = "app" | "workspace";

export type AppAgentsTab = "defaults" | "customs" | "complexity" | "fallback" | "pause";
export type WorkspaceAgentsTab = "this-agent" | "customs" | "complexity" | "fallback" | "pause";
export type AgentsHubTab = AppAgentsTab | WorkspaceAgentsTab;

export interface AgentsHubTabDef {
  id: AgentsHubTab;
  label: string;
}

export const APP_AGENTS_TABS: readonly AgentsHubTabDef[] = [
  { id: "defaults", label: "Defaults" },
  { id: "customs", label: "Customs" },
  { id: "complexity", label: "Complexity" },
  { id: "fallback", label: "Fallback" },
  { id: "pause", label: "Pause" },
];

export const WORKSPACE_AGENTS_TABS: readonly AgentsHubTabDef[] = [
  { id: "this-agent", label: "This agent" },
  { id: "customs", label: "Customs" },
  { id: "complexity", label: "Complexity" },
  { id: "fallback", label: "Fallback" },
  { id: "pause", label: "Pause" },
];

/// Keywords for the single top-level Agents section. First entry is the
/// nav label (`sectionLabel` takes keywords[0]).
export const AGENTS_SECTION_KEYWORDS: readonly string[] = [
  "Agents",
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
  // Workspace This-agent tab (harmless on the app page).
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

/// Which inner tab a search query should open when the Agents section
/// just became visible. Falls back to the scope's first tab.
export function agentsTabForQuery(scope: AgentsHubScope, query: string): AgentsHubTab {
  const q = query.trim().toLowerCase();
  const tabs = scope === "app" ? APP_AGENTS_TABS : WORKSPACE_AGENTS_TABS;
  if (!q) return tabs[0].id;

  const hits: [AgentsHubTab, string[]][] = [
    ["customs", ["custom", "command", "model flag", "effort flag", "api family", "named"]],
    ["complexity", ["complexity", "difficulty"]],
    ["fallback", ["fallback", "arm", "usage limit", "quota", "rate limit"]],
    ["pause", ["pause", "cycle", "schedule"]],
    ["defaults", ["default", "effort", "reasoning", "thinking"]],
    ["this-agent", ["this agent", "profile", "agent file", "mcp", "superpowers"]],
  ];
  for (const [tab, words] of hits) {
    if (!tabs.some((t) => t.id === tab)) continue;
    if (words.some((w) => q.includes(w))) return tab;
  }
  return tabs[0].id;
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

/// Profiles the Defaults tab offers model/effort rows for: built-ins
/// plus every custom in scope (merged list already carries locals).
export function profilesForDefaults(profiles: AgentProfileInfo[]): AgentProfileInfo[] {
  return profiles;
}

export function effortCapableProfiles(profiles: AgentProfileInfo[]): AgentProfileInfo[] {
  return profiles.filter((p) => Boolean(p.effortFlag?.trim()) || !isStockProfileId(p.id));
}

/// Label for a profile picker option. Locals are marked so a workspace
/// list of built-ins ∪ app-wide ∪ locals stays readable.
export function profileOptionLabel(profile: { label: string; local?: boolean }): string {
  return profile.local ? `${profile.label} (local)` : profile.label;
}

/// True when the id is a named custom (app-wide or `local:`), not a
/// built-in. Replaces the old `profileId === "custom"` checks.
export function isCustomProfileId(id: string): boolean {
  return !isStockProfileId(id);
}
