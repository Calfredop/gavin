// The search boxes and Plans status filter the hub tabs keep per
// workspace, remembered across tab switches AND restarts. (The shared
// context/kind/rail/label facets are hubFacets.ts; Review's query is
// reviewPrefs.ts; Decisions' is decisionsState.ts.)
//
// Persisted only because every one of these boxes shows its text and
// carries a Reset, so a remembered filter is never an invisible one.

import { writable } from "svelte/store";
import { HUB_SEARCH_KEY, isStringArray, loadRecord, mirrorRecord } from "$lib/hub/hubFilterStorage";

export interface HubSearch {
  /// The Kanban tab's search box.
  kanban: string;
  /// The Plans tab's search box and its status facet (+ NOT switches).
  plansQuery: string;
  plansStatus: string[];
  plansStatusExclude: string[];
}

function empty(): HubSearch {
  return { kanban: "", plansQuery: "", plansStatus: [], plansStatusExclude: [] };
}

function revive(value: unknown): HubSearch | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return {
    kanban: typeof v.kanban === "string" ? v.kanban : "",
    plansQuery: typeof v.plansQuery === "string" ? v.plansQuery : "",
    plansStatus: isStringArray(v.plansStatus) ? v.plansStatus : [],
    plansStatusExclude: isStringArray(v.plansStatusExclude) ? v.plansStatusExclude : [],
  };
}

export const hubSearchState = writable<Record<string, HubSearch>>(loadRecord(HUB_SEARCH_KEY, revive));

mirrorRecord(hubSearchState, HUB_SEARCH_KEY, (s) =>
  s.kanban === "" && s.plansQuery === "" && s.plansStatus.length === 0 && s.plansStatusExclude.length === 0 ? null : s
);

export function searchFor(all: Record<string, HubSearch>, workspaceId: string): HubSearch {
  return { ...empty(), ...all[workspaceId] };
}

export function setHubSearch(workspaceId: string, patch: Partial<HubSearch>): void {
  hubSearchState.update((all) => ({ ...all, [workspaceId]: { ...searchFor(all, workspaceId), ...patch } }));
}
