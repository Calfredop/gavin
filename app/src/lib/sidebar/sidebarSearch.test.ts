import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  closeSidebarSearch,
  openSidebarSearch,
  searchSidebar,
  sidebarSearchOpen,
  sidebarSearchQuery,
  toggleSidebarSearch,
  type SidebarSearchInput,
} from "$lib/sidebar/sidebarSearch";
import type { PageTabState } from "$lib/sidebar/sidebarSummary";
import type { LayoutNode } from "$lib/panes/layout";
import type { Page, Workspace } from "$lib/core/workspace";

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, name: string, tabs: string[] = []): Page {
  return { id, name, layout: leaf(tabs), focusedSessionId: null };
}

function workspace(id: string, name: string, pages: Page[]): Workspace {
  return { id, name, pages, activePageId: pages[0]?.id ?? null };
}

function input(
  workspaces: Workspace[],
  overrides: Partial<SidebarSearchInput> = {}
): SidebarSearchInput {
  const tabs: PageTabState = {
    sessionStatusById: {},
    fileTabsById: {},
    boardTabsById: {},
    cardTabsById: {},
  };
  return { workspaces, tabs, sessionNames: {}, cwdBySessionId: {}, ...overrides };
}

describe("what the sidebar's search finds", () => {
  it("returns nothing at all for a blank query", () => {
    const state = input([workspace("w1", "auth", [page("p1", "auth page", ["s1"])])]);
    expect(searchSidebar(state, "")).toEqual({ hits: [], total: 0 });
    expect(searchSidebar(state, "   ")).toEqual({ hits: [], total: 0 });
  });

  // The whole point of the feature: the three kinds form a containment
  // hierarchy, and someone searching "auth" wants the workspace called
  // auth before the nine sessions sitting inside it.
  it("ranks workspaces, then pages, then sessions", () => {
    const state = input(
      [
        workspace("w1", "auth", [page("p1", "auth review", ["s1"])]),
        workspace("w2", "other", [page("p2", "spare", ["s2"])]),
      ],
      { sessionNames: { s1: "auth agent", s2: "auth shell" } }
    );
    const { hits } = searchSidebar(state, "auth");
    expect(hits.map((h) => [h.kind, h.label])).toEqual([
      ["workspace", "auth"],
      ["page", "auth review"],
      ["session", "auth agent"],
      ["session", "auth shell"],
    ]);
  });

  it("keeps the sidebar's own order within a kind", () => {
    const state = input([
      workspace("w1", "one repo", [page("p1", "repo a"), page("p2", "repo b")]),
      workspace("w2", "two repo", []),
    ]);
    const { hits } = searchSidebar(state, "repo");
    expect(hits.map((h) => h.label)).toEqual(["one repo", "two repo", "repo a", "repo b"]);
  });

  it("names each hit's parent, and a workspace's is nothing", () => {
    const state = input([workspace("w1", "auth", [page("p1", "main", ["s1"])])], {
      sessionNames: { s1: "main agent" },
    });
    const { hits } = searchSidebar(state, "main");
    expect(hits.map((h) => [h.kind, h.where])).toEqual([
      ["page", "auth"],
      ["session", "main"],
    ]);
    expect(searchSidebar(state, "auth").hits[0].where).toBeNull();
  });

  it("carries what a hit needs to be opened", () => {
    const state = input([workspace("w1", "auth", [page("p1", "main", ["s1"])])], {
      sessionNames: { s1: "runner" },
      tabs: {
        sessionStatusById: { s1: "working" },
        fileTabsById: {},
        boardTabsById: {},
        cardTabsById: {},
      },
    });
    expect(searchSidebar(state, "runner").hits[0]).toMatchObject({
      kind: "session",
      workspaceId: "w1",
      pageId: "p1",
      sessionId: "s1",
      status: "working",
    });
    expect(searchSidebar(state, "main").hits[0]).toMatchObject({
      workspaceId: "w1",
      pageId: "p1",
      sessionId: null,
    });
    expect(searchSidebar(state, "auth").hits[0]).toMatchObject({
      workspaceId: "w1",
      pageId: null,
      sessionId: null,
    });
  });

  // A file, board or card tab has no name of its own -- its label is
  // derived from a path or a card, and those are the board's search to
  // find, not this one's.
  it("searches terminal tabs only", () => {
    const state = input([workspace("w1", "ws", [page("p1", "page", ["s1", "f1", "b1", "c1"])])], {
      sessionNames: { s1: "hunt", f1: "hunt", b1: "hunt", c1: "hunt" },
      tabs: {
        sessionStatusById: {},
        fileTabsById: { f1: {} },
        boardTabsById: { b1: {} },
        cardTabsById: { c1: {} },
      },
    });
    const { hits } = searchSidebar(state, "hunt");
    expect(hits.map((h) => h.sessionId)).toEqual(["s1"]);
  });

  // sessionLabel's own fallback chain, so a session with no custom name
  // is still findable by the folder it runs in.
  it("falls back to a session's folder when it has no name", () => {
    const state = input([workspace("w1", "ws", [page("p1", "page", ["s1"])])], {
      cwdBySessionId: { s1: "/Users/me/code/gavin" },
    });
    expect(searchSidebar(state, "gavin").hits.map((h) => h.label)).toEqual(["gavin"]);
  });

  it("every token has to appear, in any order", () => {
    const state = input([workspace("w1", "git tab worktrees", [])]);
    expect(searchSidebar(state, "tab git").hits).toHaveLength(1);
    expect(searchSidebar(state, "git branches").hits).toHaveLength(0);
  });

  it("keys every hit apart so the list can be keyed on it", () => {
    const state = input([workspace("x", "x", [page("x", "x", ["x"])])], {
      sessionNames: { x: "x" },
    });
    const { hits } = searchSidebar(state, "x");
    expect(new Set(hits.map((h) => h.key)).size).toBe(hits.length);
  });

  // Truncation has to be visible: a list that silently stopped at twenty
  // would make the twenty-first workspace unreachable and unmentioned.
  it("caps the list but reports the true total", () => {
    const many = Array.from({ length: 25 }, (_, i) => workspace(`w${i}`, `repo ${i}`, []));
    const { hits, total } = searchSidebar(input(many), "repo", 20);
    expect(hits).toHaveLength(20);
    expect(total).toBe(25);
  });
});

describe("the search row's own state", () => {
  beforeEach(() => closeSidebarSearch());

  it("toggles open and shut", () => {
    toggleSidebarSearch();
    expect(get(sidebarSearchOpen)).toBe(true);
    toggleSidebarSearch();
    expect(get(sidebarSearchOpen)).toBe(false);
  });

  // A row that reopened still filtered is the one way this can hide a
  // workspace from someone who has stopped looking for anything.
  it("clears the query whenever it closes", () => {
    openSidebarSearch();
    sidebarSearchQuery.set("auth");
    toggleSidebarSearch();
    expect(get(sidebarSearchQuery)).toBe("");

    openSidebarSearch();
    sidebarSearchQuery.set("auth");
    closeSidebarSearch();
    expect(get(sidebarSearchQuery)).toBe("");
  });
});
