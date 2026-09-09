import { describe, it, expect } from "vitest";
import {
  WORKSPACE_EXPANSION_KEY,
  PAGE_EXPANSION_KEY,
  pruneWorkspaceExpansion,
  pruneExpandedPages,
  loadWorkspaceExpansion,
  saveWorkspaceExpansion,
  loadExpandedPages,
  saveExpandedPages,
} from "$lib/sidebarExpansion";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("sidebar expansion storage", () => {
  it("keys both preferences under the app's namespace, apart from each other", () => {
    expect(WORKSPACE_EXPANSION_KEY).toMatch(/^gavin\./);
    expect(PAGE_EXPANSION_KEY).toMatch(/^gavin\./);
    expect(WORKSPACE_EXPANSION_KEY).not.toBe(PAGE_EXPANSION_KEY);
  });

  it("remembers nothing when nothing has been written", () => {
    const storage = fakeStorage();
    expect(loadWorkspaceExpansion(storage)).toEqual({});
    expect(loadExpandedPages(storage)).toEqual(new Set());
  });

  it("survives with no storage at all, as under SSR or vitest", () => {
    expect(loadWorkspaceExpansion(undefined)).toEqual({});
    expect(loadExpandedPages(undefined)).toEqual(new Set());
    expect(() => saveWorkspaceExpansion({ w1: true }, ["w1"], undefined)).not.toThrow();
    expect(() => saveExpandedPages(["p1"], ["p1"], undefined)).not.toThrow();
  });

  it("carries a workspace's expansion across a remount", () => {
    const storage = fakeStorage();
    saveWorkspaceExpansion({ w1: true, w2: false }, ["w1", "w2"], storage);
    expect(loadWorkspaceExpansion(storage)).toEqual({ w1: true, w2: false });
  });

  // The whole reason workspaces are tri-state: a collapse is an answer,
  // and it has to be told apart from "never opened" so the sidebar's
  // first-activation auto-expand cannot undo it on the next mount.
  it("keeps a deliberate collapse distinct from an unanswered workspace", () => {
    const storage = fakeStorage();
    saveWorkspaceExpansion({ w1: false }, ["w1", "w2"], storage);
    const answers = loadWorkspaceExpansion(storage);
    expect(answers.w1).toBe(false);
    expect(answers.w2).toBeUndefined();
  });

  it("carries a page's expansion across a remount", () => {
    const storage = fakeStorage();
    saveExpandedPages(["p1", "p3"], ["p1", "p2", "p3"], storage);
    expect(loadExpandedPages(storage)).toEqual(new Set(["p1", "p3"]));
  });

  it("forgets rather than throwing on corrupt or hand-edited values", () => {
    expect(loadWorkspaceExpansion(fakeStorage({ [WORKSPACE_EXPANSION_KEY]: "{oops" }))).toEqual({});
    expect(loadWorkspaceExpansion(fakeStorage({ [WORKSPACE_EXPANSION_KEY]: "[1,2]" }))).toEqual({});
    expect(loadExpandedPages(fakeStorage({ [PAGE_EXPANSION_KEY]: "{oops" }))).toEqual(new Set());
    expect(loadExpandedPages(fakeStorage({ [PAGE_EXPANSION_KEY]: '{"p1":true}' }))).toEqual(new Set());
  });

  // A non-boolean entry leaves that workspace UNANSWERED rather than
  // pinned open: a coerced value would silently outrank the human.
  it("drops entries that are not booleans or page-id strings", () => {
    const answers = loadWorkspaceExpansion(
      fakeStorage({ [WORKSPACE_EXPANSION_KEY]: '{"w1":true,"w2":"yes","w3":1}' })
    );
    expect(answers).toEqual({ w1: true });
    expect(loadExpandedPages(fakeStorage({ [PAGE_EXPANSION_KEY]: '["p1",7,"",null]' }))).toEqual(
      new Set(["p1"])
    );
  });

  it("reads back a storage that refuses to be read", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadWorkspaceExpansion(hostile)).toEqual({});
    expect(loadExpandedPages(hostile)).toEqual(new Set());
    expect(() => saveWorkspaceExpansion({ w1: true }, ["w1"], hostile)).not.toThrow();
    expect(() => saveExpandedPages(["p1"], ["p1"], hostile)).not.toThrow();
  });
});

describe("pruning", () => {
  // Ids are uuids, so an entry for a deleted workspace or a closed page
  // can never match anything again -- kept, it would grow for the life of
  // the install.
  it("drops workspaces and pages that no longer exist", () => {
    expect(pruneWorkspaceExpansion({ w1: true, gone: false }, ["w1"])).toEqual({ w1: true });
    expect(pruneExpandedPages(["p1", "gone"], ["p1", "p2"])).toEqual(["p1"]);
  });

  it("keeps a collapsed workspace that still exists, rather than only the open ones", () => {
    expect(pruneWorkspaceExpansion({ w1: false }, ["w1"])).toEqual({ w1: false });
  });

  it("writes each page once, however often it was handed over", () => {
    expect(pruneExpandedPages(["p1", "p1"], ["p1"])).toEqual(["p1"]);
  });

  it("prunes on the way to storage, not only in memory", () => {
    const storage = fakeStorage();
    saveWorkspaceExpansion({ w1: true, gone: true }, ["w1"], storage);
    saveExpandedPages(["p1", "gone"], ["p1"], storage);
    expect(storage.data[WORKSPACE_EXPANSION_KEY]).toBe('{"w1":true}');
    expect(storage.data[PAGE_EXPANSION_KEY]).toBe('["p1"]');
  });
});
