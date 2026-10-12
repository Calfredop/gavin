// Where the hub tabs' filters survive a restart. Filters are per-human VIEW
// preferences, so they live in localStorage for the reason hubTabPrefs.ts
// spells out: no daemon request, no protocol bump, and no config.json
// field for a dozen Tauri commands to carry through.
//
// Each filter store keeps its in-memory shape and mirrors it here: it
// starts from `loadRecord` and writes back through `mirrorRecord`. Only
// non-default entries are written, so a workspace nobody filtered costs
// nothing and a removed workspace's entry is gone the next time it clears.
//
// Reads forgive everything -- absent, corrupt, hand-edited, a storage that
// throws, or no storage at all (vitest's node environment, SSR). Forgetting
// is the only acceptable failure for a view preference.

import type { Readable } from "svelte/store";

type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const HUB_FACETS_KEY = "gavin.hubFacets";
export const HUB_SEARCH_KEY = "gavin.hubSearch";
export const HUB_DECISIONS_FILTER_KEY = "gavin.hubDecisionsFilter";

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/// The stored record, each entry passed through `revive` (which returns
/// null for one it cannot use).
export function loadRecord<T>(
  key: string,
  revive: (value: unknown) => T | null,
  storage: MaybeStorage = defaultStorage()
): Record<string, T> {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, T> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = revive(value);
      if (entry !== null) out[id] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/// Write `store` back on every change. `project` maps an entry to what is
/// stored, or null when it is the default and need not be.
export function mirrorRecord<T, S>(
  store: Readable<Record<string, T>>,
  key: string,
  project: (entry: T) => S | null,
  storage: MaybeStorage = defaultStorage()
): void {
  store.subscribe((all) => {
    try {
      const out: Record<string, S> = {};
      for (const [id, entry] of Object.entries(all)) {
        const stored = project(entry);
        if (stored !== null) out[id] = stored;
      }
      if (Object.keys(out).length === 0) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(out));
    } catch {
      // Best-effort: a full or blocked storage must never break a tab.
    }
  });
}
