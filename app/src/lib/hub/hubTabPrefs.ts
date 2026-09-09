// Who arranged the hub tab strip, and how. Two preferences, at two
// levels: the ORDER the tabs sit in (one workspace's own, written by
// dragging them) and the set that is HIDDEN (an app-wide default, which
// any workspace may override).
//
// Per-human view preferences rather than workspace data -- which
// sections of the app this screen shows, and in what order, is not a
// fact about any project -- so they go where the sidebar's expansion and
// the Plans tab's selection already live: localStorage. No daemon
// request, so no protocol bump and no compat gate.
//
// Deliberately NOT config.json, for the reason sidebarPrefs.ts spells
// out at length: every AppConfig field is a carry-through field that a
// dozen Tauri commands each have to hand back to `save`, and one that
// forgets silently resets it. That price buys nothing here -- nothing
// outside this window needs to know which tabs it draws.
//
// The ORDER is per workspace and never inherits. It is written by
// dragging a tab in a particular strip, and a drag in one workspace
// silently rearranging the other four would be a gesture with a much
// larger blast radius than it looks. HIDING does inherit, because it is
// the answer to "which parts of gavin do I use", which is usually the
// same everywhere -- hence a default in app Settings and an override per
// workspace.

import { get, writable } from "svelte/store";
import {
  manageableHubViewIds,
  orderableHubViewIds,
  resolveHubView,
  type HubTabPrefs,
} from "$lib/hub/hubViewMeta";
import { getActiveView, getActiveWorkspace } from "$lib/workspace";
import { layoutState, switchWorkspaceView } from "$lib/layoutState";

/// Injected (defaulting to the browser's) for the same two reasons
/// sidebarExpansion.ts injects it: vitest's node environment has no
/// localStorage at all, and an SSR pass has none either -- both must
/// remember nothing rather than throw.
type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const HIDDEN_DEFAULT_KEY = "gavin.hubTabsHiddenDefault";
export const HIDDEN_BY_WORKSPACE_KEY = "gavin.hubTabsHidden";
export const ORDER_BY_WORKSPACE_KEY = "gavin.hubTabsOrder";

/// Ids of workspaces that still exist. Everything else is dropped on the
/// next write, exactly as the sidebar's expansion records are pruned:
/// workspace ids are uuids, so a removed workspace's entry can never
/// match anything again and would otherwise grow for the life of the
/// install.
export type KnownIds = Iterable<string>;

/// A stored list of view ids, or null when there is nothing usable
/// there. Unknown ids are dropped rather than kept: an id from a gavin
/// that named its tabs differently can only ever hide or order nothing,
/// and leaving it in the list would make "is anything hidden?" answer
/// yes forever.
///
/// Null and an EMPTY list are different answers, and both are reachable:
/// null is "nothing stored", `[]` is "stored, hides nothing" -- which is
/// how a workspace overrides an app default that hides things.
export function normalizeHubViewIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const known = new Set(orderableHubViewIds());
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !known.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}

function readJson(storage: MaybeStorage, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    // Absent, corrupt, hand-edited, or a storage that refuses to be
    // read: forgetting is the only acceptable failure mode for a view
    // preference.
    return null;
  }
}

function writeJson(storage: MaybeStorage, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort: a full or blocked storage must never break the strip.
  }
}

export function loadHiddenDefault(storage: MaybeStorage = defaultStorage()): string[] {
  return normalizeHubViewIdList(readJson(storage, HIDDEN_DEFAULT_KEY)) ?? [];
}

export function saveHiddenDefault(
  hidden: string[],
  storage: MaybeStorage = defaultStorage()
): void {
  writeJson(storage, HIDDEN_DEFAULT_KEY, hidden.length > 0 ? hidden : null);
}

/// A record keyed by workspace id, with every entry normalized and every
/// unknown workspace dropped. Used for both per-workspace records; they
/// differ only in what the lists mean.
export function loadByWorkspace(
  key: string,
  storage: MaybeStorage = defaultStorage()
): Record<string, string[]> {
  const parsed = readJson(storage, key);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const ids = normalizeHubViewIdList(value);
    if (ids !== null) out[id] = ids;
  }
  return out;
}

export function pruneByWorkspace(
  record: Record<string, string[]>,
  knownIds: KnownIds
): Record<string, string[]> {
  const known = new Set(knownIds);
  const kept: Record<string, string[]> = {};
  for (const [id, ids] of Object.entries(record)) {
    if (known.has(id)) kept[id] = ids;
  }
  return kept;
}

export function saveByWorkspace(
  key: string,
  record: Record<string, string[]>,
  knownIds: KnownIds,
  storage: MaybeStorage = defaultStorage()
): void {
  const pruned = pruneByWorkspace(record, knownIds);
  writeJson(storage, key, Object.keys(pruned).length > 0 ? pruned : null);
}

/// The app-wide hidden set: the tabs a workspace that has said nothing
/// of its own does not draw. Empty is the shipped state -- every section
/// on offer.
export const hubTabsHiddenDefault = writable<string[]>(loadHiddenDefault());

/// Per-workspace overrides. PRESENCE of a key is the override; a
/// workspace with no key inherits the default, which is why this cannot
/// be flattened into "hidden ids per workspace, defaulting to the app
/// list".
export const hubTabsHiddenByWorkspace = writable<Record<string, string[]>>(
  loadByWorkspace(HIDDEN_BY_WORKSPACE_KEY)
);

/// Per-workspace tab order, written by dragging a tab. No app-wide
/// level: see this module's header.
export const hubTabOrderByWorkspace = writable<Record<string, string[]>>(
  loadByWorkspace(ORDER_BY_WORKSPACE_KEY)
);

/// Whether the strip is currently arrangeable. Locked by default and
/// deliberately NOT persisted: an unlock that survived a reload would
/// not be a mode you enter, it would be a setting -- and the whole point
/// of the lock is that a tab does not move when you meant to click it.
///
/// App-wide rather than per workspace because it is a mode the human is
/// in, not a property of a workspace: unlocking, then switching
/// workspaces to arrange that strip too, is the obvious thing to want.
export const hubTabsUnlocked = writable<boolean>(false);

export function toggleHubTabsUnlocked(): void {
  hubTabsUnlocked.update((unlocked) => !unlocked);
}

/// One workspace's effective preferences, assembled from the three
/// stores' values. Pure and passed its inputs so the strip, the ⌘-digit
/// router and the settings panels all read the same rule -- and so the
/// inheritance ("no key here means the app default") is written once.
export function hubTabPrefsFor(
  workspaceId: string,
  order: Record<string, string[]>,
  hiddenByWorkspace: Record<string, string[]>,
  hiddenDefault: string[]
): HubTabPrefs {
  return {
    order: order[workspaceId] ?? null,
    hidden: hiddenByWorkspace[workspaceId] ?? hiddenDefault,
  };
}

/// The same answer for a caller with no store subscriptions of its own --
/// the keyboard router, which is a plain function called on a keystroke.
export function currentHubTabPrefs(workspaceId: string): HubTabPrefs {
  return hubTabPrefsFor(
    workspaceId,
    get(hubTabOrderByWorkspace),
    get(hubTabsHiddenByWorkspace),
    get(hubTabsHiddenDefault)
  );
}

/// Whether this workspace has an answer of its own, or is following the
/// app-wide default. The settings panel needs the distinction to offer
/// "follow the default again" at all.
export function workspaceOverridesHubTabs(
  workspaceId: string,
  hiddenByWorkspace: Record<string, string[]>
): boolean {
  return workspaceId in hiddenByWorkspace;
}

/// The ids a write may keep, always including the one being written.
/// Pruning is what stops these records growing for the life of the
/// install, but it must never be able to throw away the entry it was
/// called to store -- a save that ran before the layout finished loading
/// would otherwise see no workspaces at all and prune everything.
function knownWorkspaceIds(writing: string): string[] {
  return [writing, ...get(layoutState).workspaces.map((w) => w.id)];
}

/// Hiding the tab the human is standing on would leave the view on
/// screen with nothing in the strip pointing at it -- reachable until
/// they clicked away, and then not at all. Moving them off is the same
/// courtesy setScratchpadEnabled pays when it takes away the row you are
/// standing in.
///
/// Only the ACTIVE workspace: it is the only one with a view on screen,
/// and every other one re-resolves its remembered tab through
/// resolveHubView the next time it is opened.
function keepActiveHubViewReachable(): void {
  const state = get(layoutState);
  const ws = getActiveWorkspace(state);
  if (!ws) return;
  const showing = getActiveView(ws);
  if (showing === "terminal") return;
  const resolved = resolveHubView({ ...ws, hubView: showing }, currentHubTabPrefs(ws.id));
  if (resolved !== showing) void switchWorkspaceView(ws.id, resolved);
}

/// The app-wide hidden set. Every workspace that has said nothing of its
/// own follows this one, live.
export function setHubTabsHiddenDefault(hidden: string[]): void {
  hubTabsHiddenDefault.set(hidden);
  saveHiddenDefault(hidden);
  keepActiveHubViewReachable();
}

/// One workspace's own hidden set, or `null` to follow the app-wide
/// default again. Null REMOVES the key rather than storing the default's
/// current value, so a later change to the default still reaches this
/// workspace -- absence is the inheritance.
export function setWorkspaceHubTabsHidden(workspaceId: string, hidden: string[] | null): void {
  hubTabsHiddenByWorkspace.update((current) => {
    const next = { ...current };
    if (hidden === null) delete next[workspaceId];
    else next[workspaceId] = hidden;
    saveByWorkspace(HIDDEN_BY_WORKSPACE_KEY, next, knownWorkspaceIds(workspaceId));
    return next;
  });
  keepActiveHubViewReachable();
}

/// One workspace's tab order, or `null` to go back to the order gavin
/// declares. Stored as a full order over every orderable id -- see
/// moveHubViewId, which is what produces it.
export function setWorkspaceHubTabOrder(workspaceId: string, order: string[] | null): void {
  hubTabOrderByWorkspace.update((current) => {
    const next = { ...current };
    if (order === null) delete next[workspaceId];
    else next[workspaceId] = order;
    saveByWorkspace(ORDER_BY_WORKSPACE_KEY, next, knownWorkspaceIds(workspaceId));
    return next;
  });
}

/// Whether this workspace's strip has been rearranged -- the settings
/// panel's "Reset order" only earns its place while there is an order to
/// reset.
export function workspaceHasHubTabOrder(
  workspaceId: string,
  order: Record<string, string[]>
): boolean {
  return workspaceId in order;
}

/// How many of the manageable sections a hidden set takes away. Both
/// panels say this rather than leaving the human to count eyes.
export function hiddenHubViewCount(hidden: string[]): number {
  const manageable = new Set(manageableHubViewIds());
  return hidden.filter((id) => manageable.has(id)).length;
}
