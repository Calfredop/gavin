import { describe, it, expect } from "vitest";
import {
  loadViewMode,
  saveViewMode,
  viewModeStorageKey,
  VIEW_MODES,
} from "$lib/orchestration/orchestrationViewMode";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

// The switcher is a view preference with nothing in the plan to hang it
// on, and the tab is destroyed on every switch away -- the same shape as
// the conflicts box's collapse, and kept the same way.
describe("the orchestration view mode", () => {
  it("offers exactly the two views, rails first", () => {
    expect(VIEW_MODES).toEqual(["rails", "nodes"]);
  });

  it("defaults to the rails view", () => {
    expect(loadViewMode("ws1", memoryStorage())).toBe("rails");
    expect(loadViewMode("ws1", undefined)).toBe("rails");
  });

  it("remembers the nodes view per workspace", () => {
    const storage = memoryStorage();
    saveViewMode("ws1", "nodes", storage);
    expect(loadViewMode("ws1", storage)).toBe("nodes");
    expect(loadViewMode("ws2", storage)).toBe("rails");
    expect(storage.map.get(viewModeStorageKey("ws1"))).toBe("nodes");
  });

  it("remembers switching back too", () => {
    const storage = memoryStorage();
    saveViewMode("ws1", "nodes", storage);
    saveViewMode("ws1", "rails", storage);
    expect(loadViewMode("ws1", storage)).toBe("rails");
  });

  // Forgetting is the only acceptable failure mode for a view
  // preference: a value this build does not know, a hand edit, a
  // storage that throws -- all read as the default.
  it("reads anything it does not recognise as the rails view", () => {
    expect(loadViewMode("ws1", memoryStorage({ [viewModeStorageKey("ws1")]: "canvas" }))).toBe("rails");
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadViewMode("ws1", throwing)).toBe("rails");
    expect(() => saveViewMode("ws1", "nodes", throwing)).not.toThrow();
  });
});
