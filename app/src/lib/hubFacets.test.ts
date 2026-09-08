import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { ANY, NO_FACETS, type BoardFacets } from "./boardFilters";
import { facetsFor, hubFacetState, isTabLinked, resetTabFacets, setTabFacets, setTabLinked } from "./hubFacets";

const WS = "ws1";

function context(): BoardFacets {
  return { context: "/ws/auth", kind: ANY, rail: ANY };
}

beforeEach(() => {
  hubFacetState.set({});
});

describe("facetsFor / isTabLinked", () => {
  it("starts every tab linked to NO_FACETS for an unknown workspace", () => {
    expect(isTabLinked(undefined, "kanban")).toBe(true);
    expect(facetsFor(undefined, "review")).toEqual(NO_FACETS);
  });
});

describe("setTabFacets while linked", () => {
  it("writes shared, and every other linked tab reads it back", () => {
    setTabFacets(WS, "kanban", context());
    const ws = get(hubFacetState)[WS];
    expect(facetsFor(ws, "kanban")).toEqual(context());
    expect(facetsFor(ws, "review")).toEqual(context());
    expect(facetsFor(ws, "plans")).toEqual(context());
  });
});

describe("unlinking", () => {
  it("freezes the tab's current reading and stops it following further shared changes", () => {
    setTabFacets(WS, "kanban", context());
    setTabLinked(WS, "review", false);
    const frozen = get(hubFacetState)[WS];
    expect(facetsFor(frozen, "review")).toEqual(context());

    // Kanban and Plans stay linked and move together; Review does not.
    const changed: BoardFacets = { context: ANY, kind: "task", rail: ANY };
    setTabFacets(WS, "plans", changed);
    const ws = get(hubFacetState)[WS];
    expect(facetsFor(ws, "kanban")).toEqual(changed);
    expect(facetsFor(ws, "plans")).toEqual(changed);
    expect(facetsFor(ws, "review")).toEqual(context());
    expect(isTabLinked(ws, "review")).toBe(false);
  });

  it("edits from an unlinked tab do not reach the linked ones", () => {
    setTabLinked(WS, "review", false);
    setTabFacets(WS, "review", { context: ANY, kind: ANY, rail: "r1" });
    const ws = get(hubFacetState)[WS];
    expect(facetsFor(ws, "kanban")).toEqual(NO_FACETS);
    expect(facetsFor(ws, "review")).toEqual({ context: ANY, kind: ANY, rail: "r1" });
  });
});

describe("relinking", () => {
  it("drops the tab's own answer and rejoins at whatever shared reads now", () => {
    setTabLinked(WS, "review", false);
    setTabFacets(WS, "review", { context: ANY, kind: ANY, rail: "r1" });
    setTabFacets(WS, "kanban", context());
    setTabLinked(WS, "review", true);
    const ws = get(hubFacetState)[WS];
    expect(isTabLinked(ws, "review")).toBe(true);
    expect(facetsFor(ws, "review")).toEqual(context());

    // And it follows further shared changes again.
    const changed: BoardFacets = { context: ANY, kind: "note", rail: ANY };
    setTabFacets(WS, "plans", changed);
    expect(facetsFor(get(hubFacetState)[WS], "review")).toEqual(changed);
  });
});

describe("resetTabFacets", () => {
  it("clears shared for a linked tab", () => {
    setTabFacets(WS, "kanban", context());
    resetTabFacets(WS, "kanban");
    expect(facetsFor(get(hubFacetState)[WS], "review")).toEqual(NO_FACETS);
  });

  it("clears only the unlinked tab's own facets", () => {
    setTabFacets(WS, "kanban", context());
    setTabLinked(WS, "review", false);
    setTabFacets(WS, "review", { context: ANY, kind: ANY, rail: "r1" });
    resetTabFacets(WS, "review");
    const ws = get(hubFacetState)[WS];
    expect(facetsFor(ws, "review")).toEqual(NO_FACETS);
    expect(facetsFor(ws, "kanban")).toEqual(context());
  });
});
