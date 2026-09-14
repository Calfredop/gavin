import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  criticalReviewRuns,
  dropRun,
  hydrateRuns,
  parseRuns,
  putRun,
  runForPage,
  runsNeedingFindingsRail,
  critiqueSessionIdsByStep,
  runsStorageKey,
  type CriticalReviewRun,
} from "$lib/review/criticalReviewState";

function run(over: Partial<CriticalReviewRun> = {}): CriticalReviewRun {
  return {
    pageId: "p1",
    startedAt: 1,
    subjectKind: "card",
    subjectLabel: "Fix login",
    cardPath: "/repo/x.md",
    railId: null,
    alsoBuildFindingsRail: false,
    sessionIds: ["s1", "s2"],
    stepId: null,
    ...over,
  };
}

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    map,
  };
}

beforeEach(() => {
  criticalReviewRuns.set({});
});

describe("parseRuns", () => {
  it("forgives absence and corruption", () => {
    expect(parseRuns(null)).toEqual([]);
    expect(parseRuns("not json")).toEqual([]);
    expect(parseRuns("{}")).toEqual([]);
  });

  it("keeps a well-formed run and drops junk", () => {
    const raw = JSON.stringify([run(), { pageId: "" }, null, run({ pageId: "p2", alsoBuildFindingsRail: true })]);
    const parsed = parseRuns(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].alsoBuildFindingsRail).toBe(true);
  });
});

describe("put / drop / hydrate", () => {
  it("round-trips through storage", () => {
    const storage = memStorage();
    putRun("ws-1", run({ alsoBuildFindingsRail: true }), storage);
    expect(storage.map.get(runsStorageKey("ws-1"))).toContain("alsoBuildFindingsRail");
    criticalReviewRuns.set({});
    hydrateRuns("ws-1", storage);
    expect(get(criticalReviewRuns)["ws-1"][0].alsoBuildFindingsRail).toBe(true);
    dropRun("ws-1", "p1", storage);
    expect(storage.map.has(runsStorageKey("ws-1"))).toBe(false);
  });
});

describe("lookups", () => {
  it("finds by page and filters the auto-build toggle", () => {
    putRun("ws-1", run({ pageId: "a", alsoBuildFindingsRail: false }));
    putRun("ws-1", run({ pageId: "b", alsoBuildFindingsRail: true }));
    expect(runForPage(get(criticalReviewRuns)["ws-1"], "b")?.pageId).toBe("b");
    expect(runsNeedingFindingsRail("ws-1").map((r) => r.pageId)).toEqual(["b"]);
  });

  it("maps rail-step runs by stepId for the scheduler", () => {
    putRun("ws-1", run({ pageId: "dialog", stepId: null, sessionIds: ["a"] }));
    putRun("ws-1", run({ pageId: "step", stepId: "t-crit", sessionIds: ["s1", "s2"] }));
    const map = critiqueSessionIdsByStep(get(criticalReviewRuns)["ws-1"]);
    expect([...map.keys()]).toEqual(["t-crit"]);
    expect(map.get("t-crit")).toEqual(["s1", "s2"]);
  });
});
