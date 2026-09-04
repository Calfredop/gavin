import { describe, it, expect } from "vitest";
import {
  HIDDEN_BY_WORKSPACE_KEY,
  HIDDEN_DEFAULT_KEY,
  ORDER_BY_WORKSPACE_KEY,
  hiddenHubViewCount,
  hubTabPrefsFor,
  loadByWorkspace,
  loadHiddenDefault,
  normalizeHubViewIdList,
  pruneByWorkspace,
  saveByWorkspace,
  saveHiddenDefault,
  workspaceHasHubTabOrder,
  workspaceOverridesHubTabs,
} from "./hubTabPrefs";

/// The same fake the sidebar's preference modules use: vitest's node
/// environment has no localStorage at all, so every reader and writer
/// here takes one.
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("normalizeHubViewIdList", () => {
  it("reads a list of known ids", () => {
    expect(normalizeHubViewIdList(["git", "kanban"])).toEqual(["git", "kanban"]);
  });

  // Null and [] are different answers: null is "nothing stored", [] is
  // "stored, hides nothing" -- which is how a workspace overrides an app
  // default that hides things.
  it("tells nothing stored from an empty answer", () => {
    expect(normalizeHubViewIdList(null)).toBeNull();
    expect(normalizeHubViewIdList("git")).toBeNull();
    expect(normalizeHubViewIdList({})).toBeNull();
    expect(normalizeHubViewIdList([])).toEqual([]);
  });

  // An id from a gavin that named its tabs differently can only ever
  // hide or order nothing, and leaving it in would make "is anything
  // hidden?" answer yes forever.
  it("drops unknown ids, non-strings and duplicates", () => {
    expect(normalizeHubViewIdList(["git", "nope", 3, "git", "settings"])).toEqual(["git"]);
  });
});

describe("the app-wide hidden default", () => {
  it("round-trips", () => {
    const storage = fakeStorage();
    saveHiddenDefault(["git", "prd"], storage);
    expect(loadHiddenDefault(storage)).toEqual(["git", "prd"]);
  });

  // There is no level above the app default, so "hides nothing" and "was
  // never set" are the same state -- and the key is dropped rather than
  // left holding an empty list.
  it("takes the key away rather than storing an empty list", () => {
    const storage = fakeStorage();
    saveHiddenDefault(["git"], storage);
    saveHiddenDefault([], storage);
    expect(storage.map.has(HIDDEN_DEFAULT_KEY)).toBe(false);
    expect(loadHiddenDefault(storage)).toEqual([]);
  });

  it("reads corrupt storage as nothing hidden", () => {
    expect(loadHiddenDefault(fakeStorage({ [HIDDEN_DEFAULT_KEY]: "{oops" }))).toEqual([]);
    expect(loadHiddenDefault(undefined)).toEqual([]);
  });
});

describe("the per-workspace records", () => {
  it("round-trips, keyed by workspace", () => {
    const storage = fakeStorage();
    saveByWorkspace(ORDER_BY_WORKSPACE_KEY, { "ws-1": ["kanban", "home"] }, ["ws-1"], storage);
    expect(loadByWorkspace(ORDER_BY_WORKSPACE_KEY, storage)).toEqual({
      "ws-1": ["kanban", "home"],
    });
  });

  // Workspace ids are uuids, so an entry for a removed workspace can
  // never match anything again and would grow for the life of the
  // install.
  it("drops entries for workspaces that no longer exist", () => {
    expect(pruneByWorkspace({ "ws-1": ["git"], "ws-2": ["prd"] }, ["ws-1"])).toEqual({
      "ws-1": ["git"],
    });
  });

  // An empty list for a workspace is that workspace's override saying
  // "show everything", and must survive a save/load round trip -- it is
  // not the same as having no entry.
  it("keeps a workspace's empty override", () => {
    const storage = fakeStorage();
    saveByWorkspace(HIDDEN_BY_WORKSPACE_KEY, { "ws-1": [] }, ["ws-1"], storage);
    const loaded = loadByWorkspace(HIDDEN_BY_WORKSPACE_KEY, storage);
    expect(loaded["ws-1"]).toEqual([]);
    expect(workspaceOverridesHubTabs("ws-1", loaded)).toBe(true);
  });

  it("reads a corrupt or absent record as nothing remembered", () => {
    expect(loadByWorkspace(ORDER_BY_WORKSPACE_KEY, fakeStorage())).toEqual({});
    expect(
      loadByWorkspace(ORDER_BY_WORKSPACE_KEY, fakeStorage({ [ORDER_BY_WORKSPACE_KEY]: "[1,2]" }))
    ).toEqual({});
  });
});

describe("hubTabPrefsFor", () => {
  it("falls through to the app-wide hidden set", () => {
    expect(hubTabPrefsFor("ws-1", {}, {}, ["git"])).toEqual({ order: null, hidden: ["git"] });
  });

  it("lets a workspace override the default, empty override included", () => {
    expect(hubTabPrefsFor("ws-1", {}, { "ws-1": [] }, ["git"]).hidden).toEqual([]);
    expect(hubTabPrefsFor("ws-1", {}, { "ws-1": ["prd"] }, ["git"]).hidden).toEqual(["prd"]);
  });

  // The order never inherits: a drag in one strip must not silently
  // rearrange the other four workspaces.
  it("reads the order from this workspace alone", () => {
    const order = { "ws-2": ["kanban"] };
    expect(hubTabPrefsFor("ws-1", order, {}, []).order).toBeNull();
    expect(hubTabPrefsFor("ws-2", order, {}, []).order).toEqual(["kanban"]);
    expect(workspaceHasHubTabOrder("ws-1", order)).toBe(false);
    expect(workspaceHasHubTabOrder("ws-2", order)).toBe(true);
  });
});

describe("hiddenHubViewCount", () => {
  it("counts only the sections a panel actually lists", () => {
    expect(hiddenHubViewCount(["git", "prd"])).toBe(2);
    // A hidden set outlives the build that wrote it: an id no longer in
    // HUB_VIEW_META is counted by nothing.
    expect(hiddenHubViewCount(["retired-view"])).toBe(0);
    expect(hiddenHubViewCount([])).toBe(0);
  });
});
