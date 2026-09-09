import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import type { BestOfNRun, RunCandidate } from "$lib/cards/bestOfN";
import {
  bestOfNRuns,
  candidateLiveness,
  dropRun,
  hydrateRuns,
  loadRuns,
  parseRuns,
  putRun,
  runForCard,
  runForSession,
  runForSessionAnywhere,
  runSummary,
  runsStorageKey,
  saveRuns,
} from "$lib/cards/bestOfNState";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: (k: string) => map.get(k) ?? null,
  };
}

function candidate(over: Partial<RunCandidate> = {}): RunCandidate {
  return {
    sessionId: "s1",
    label: "Claude Code",
    profileId: "claude-code",
    model: "",
    branch: "auth-claude-code",
    worktreePath: "/repos/gavin-auth-claude-code",
    command: "claude 'do it'",
    conversationId: null,
    ...over,
  };
}

function run(over: Partial<BestOfNRun> = {}): BestOfNRun {
  return {
    cardPath: "/repo/.gavin-root/plans/auth.md",
    cardTitle: "Auth rework",
    pageId: "page-1",
    startedAt: 1700,
    candidates: [candidate(), candidate({ sessionId: "s2", branch: "auth-codex", worktreePath: "/repos/gavin-auth-codex" })],
    ...over,
  };
}

beforeEach(() => bestOfNRuns.set({}));

describe("reading back what was persisted", () => {
  it("round-trips a run", () => {
    const storage = memoryStorage();
    saveRuns("w1", [run()], storage);
    expect(loadRuns("w1", storage)).toEqual([run()]);
    expect(storage.read(runsStorageKey("w1"))).toContain("auth-codex");
  });

  it("forgives every way the blob can be unreadable", () => {
    // A view-preference-sized promise: absent, corrupt and hand-edited
    // all read as "no runs", never as an error the human has to clear.
    expect(parseRuns(null)).toEqual([]);
    expect(parseRuns("")).toEqual([]);
    expect(parseRuns("{not json")).toEqual([]);
    expect(parseRuns('{"cardPath":"x"}')).toEqual([]);
    expect(parseRuns("[null, 3, \"x\"]")).toEqual([]);
  });

  it("drops a candidate with no session or no folder, and the run if nothing survives", () => {
    // Those two fields are what the record is FOR: one cannot be picked,
    // the other cannot be cleaned up.
    const raw = JSON.stringify([
      { cardPath: "a.md", candidates: [{ sessionId: "s1" }, { worktreePath: "/x" }] },
      { cardPath: "b.md", candidates: [{ sessionId: "s1", worktreePath: "/x" }] },
    ]);
    const runs = parseRuns(raw);
    expect(runs.map((r) => r.cardPath)).toEqual(["b.md"]);
    expect(runs[0].candidates).toHaveLength(1);
  });

  it("names a candidate whose label was lost rather than showing a blank", () => {
    const runs = parseRuns(JSON.stringify([{ cardPath: "a.md", candidates: [{ sessionId: "s", worktreePath: "/x", profileId: "codex" }] }]));
    expect(runs[0].candidates[0].label).toBe("codex");
  });

  it("survives a storage that throws on read", () => {
    const angry = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(loadRuns("w1", angry)).toEqual([]);
  });
});

describe("the store the surfaces read", () => {
  it("hydrates a workspace from disk", () => {
    const storage = memoryStorage({ [runsStorageKey("w1")]: JSON.stringify([run()]) });
    hydrateRuns("w1", storage);
    expect(get(bestOfNRuns)["w1"]).toHaveLength(1);
  });

  it("writes the store and localStorage together", () => {
    // A helper that updated one without the other is how a run comes back
    // from a reload missing a candidate that is on screen.
    const storage = memoryStorage();
    putRun("w1", run(), storage);
    expect(get(bestOfNRuns)["w1"]).toHaveLength(1);
    expect(loadRuns("w1", storage)).toHaveLength(1);
    dropRun("w1", run().cardPath, storage);
    expect(get(bestOfNRuns)["w1"]).toEqual([]);
    expect(loadRuns("w1", storage)).toEqual([]);
  });

  it("replaces a second run on the same card instead of stacking one on top", () => {
    const storage = memoryStorage();
    putRun("w1", run(), storage);
    putRun("w1", run({ pageId: "page-2" }), storage);
    expect(get(bestOfNRuns)["w1"]).toHaveLength(1);
    expect(get(bestOfNRuns)["w1"][0].pageId).toBe("page-2");
  });

  it("keeps runs on other cards", () => {
    const storage = memoryStorage();
    putRun("w1", run(), storage);
    putRun("w1", run({ cardPath: "other.md" }), storage);
    dropRun("w1", "other.md", storage);
    expect(get(bestOfNRuns)["w1"].map((r) => r.cardPath)).toEqual([run().cardPath]);
  });
});

describe("finding a run", () => {
  it("finds one by card and one by session", () => {
    const runs = [run()];
    expect(runForCard(runs, run().cardPath)?.pageId).toBe("page-1");
    expect(runForCard(runs, "nope.md")).toBeNull();
    expect(runForSession(runs, "s2")?.candidate.branch).toBe("auth-codex");
    expect(runForSession(runs, "gone")).toBeNull();
    expect(runForSession(undefined, "s2")).toBeNull();
  });
});

describe("finding a run from a tab", () => {
  it("searches every workspace, since a pane tab knows only its session id", () => {
    const hit = runForSessionAnywhere({ "w1": [], "w2": [run()] }, "s2");
    expect(hit?.workspaceId).toBe("w2");
    expect(hit?.candidate.sessionId).toBe("s2");
    expect(runForSessionAnywhere({ "w1": [run()] }, "nobody")).toBeNull();
  });
});

describe("liveness", () => {
  it("reports a dead candidate rather than dropping it", () => {
    // A closed tab is not a cleaned-up worktree: the folder is still
    // there, and this record is the last thing pointing at it.
    const rows = candidateLiveness(run(), new Set(["s1"]));
    expect(rows.map((r) => r.live)).toEqual([true, false]);
    expect(rows).toHaveLength(2);
  });

  it("says what a run is doing in one phrase", () => {
    expect(runSummary(run(), new Set(["s1", "s2"]))).toBe("2 running");
    expect(runSummary(run(), new Set(["s1"]))).toBe("1 running · 1 stopped");
    expect(runSummary(run(), new Set())).toBe("2 stopped");
  });
});
