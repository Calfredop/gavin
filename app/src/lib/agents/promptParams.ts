// Per-primary prompt params: extra prompt-text LINES appended to prompts
// composed for an agent, and extra CLI ARGUMENTS appended to its launch
// command. Two maps (`promptExtras`, `extraCliArgs`) at each level, keyed
// by primary profile id, with the fallback chains' inherit semantics: a
// workspace map with no key for the primary inherits the app-wide list;
// a present key overrides — an empty list is an explicit "nothing extra"
// for that primary.
//
// Pure and unit-tested; the editors (`PromptParamsEditor.svelte`) and the
// launch/prompt paths stay templates over these.

/// Trim blanks, keep order and duplicates.
export function sanitizeList(items: readonly string[] | null | undefined): string[] {
  return (items ?? []).map((s) => s.trim()).filter(Boolean);
}

/// One primary's list in a map. A present key answers even when empty;
/// a missing key answers [] (callers wanting inherit use
/// `effectiveListForPrimary`).
export function listForPrimary(
  map: Record<string, string[]> | null | undefined,
  primaryId: string
): string[] {
  const id = (primaryId ?? "").trim();
  if (!id || map == null || !Object.prototype.hasOwnProperty.call(map, id)) return [];
  return sanitizeList(map[id]);
}

/// The list in force for `primaryId`: the workspace's override under
/// that key, else the app-wide list, else none.
export function effectiveListForPrimary(
  workspaceMap: Record<string, string[]> | null | undefined,
  appMap: Record<string, string[]> | null | undefined,
  primaryId: string
): string[] {
  const id = (primaryId ?? "").trim();
  if (!id) return [];
  if (workspaceMap != null && Object.prototype.hasOwnProperty.call(workspaceMap, id)) {
    return sanitizeList(workspaceMap[id]);
  }
  return listForPrimary(appMap, id);
}

/// Whether this workspace overrides the app list for `primaryId`.
export function workspaceOwnsList(
  workspaceMap: Record<string, string[]> | null | undefined,
  primaryId: string
): boolean {
  const id = (primaryId ?? "").trim();
  return Boolean(id && workspaceMap && Object.prototype.hasOwnProperty.call(workspaceMap, id));
}

/// Copy of `map` with one primary's list set; null removes the key so
/// that primary inherits again.
export function withListForPrimary(
  map: Record<string, string[]> | null | undefined,
  primaryId: string,
  list: readonly string[] | null
): Record<string, string[]> {
  const id = (primaryId ?? "").trim();
  const next: Record<string, string[]> = { ...(map ?? {}) };
  if (!id) return next;
  if (list == null) delete next[id];
  else next[id] = sanitizeList(list);
  return next;
}
