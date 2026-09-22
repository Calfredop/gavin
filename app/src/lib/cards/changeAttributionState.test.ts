import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  gitDiffSince: vi.fn(),
  typesafeAttribution: vi.fn(),
  readFileForViewer: vi.fn(),
}));

import * as backend from "$lib/core/backend";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { typesafeSettings } from "$lib/agents/turnVerdictState";
import {
  ATTRIBUTION_CONCURRENCY,
  __resetForTesting,
  attributeRun,
  attributionKey,
  attributionStore,
  ownersOf,
} from "$lib/cards/changeAttributionState";
import { UNATTRIBUTED } from "$lib/cards/changeAttribution";
import type { AttributionRequest } from "$lib/cards/changeAttribution";
import type { Board, CardSession } from "$lib/board/kanban";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";
import type { FileDiff, RunChanges } from "$lib/git/git";

const WS = "ws-1";
const BASE = "1111111111111111111111111111111111111111";
const SELF = "/ws/.gavin-root/plans/self.md";
const PEER = "/ws/.gavin-root/plans/peer.md";
const KEY = attributionKey(SELF, BASE, null);

function plan(path: string, title: string): PlanFileInfo {
  return {
    path,
    fileName: path.slice(path.lastIndexOf("/") + 1),
    title,
    status: "In Progress",
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
  };
}

function tree(plans: PlanFileInfo[]): GavinTree {
  return {
    rootPath: "/ws",
    rootMissing: false,
    contexts: [
      {
        folderPath: "/ws",
        kind: "root",
        name: "root",
        plans,
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

function binding(path: string, over: Partial<CardSession> = {}): CardSession {
  return { path, sessionId: `s-${path}`, cwd: "/repo", command: null, launchCwd: "/repo", baseSha: BASE, ...over };
}

function board(cardSessions: CardSession[]): Board {
  return { columns: [], labels: [], cardSessions };
}

function changes(over: Partial<RunChanges> = {}): RunChanges {
  return {
    baseSha: BASE,
    notARepo: false,
    baseMissing: false,
    root: "/repo",
    baseSubject: "base",
    files: [
      { path: "a.ts", status: "M" },
      { path: "package-lock.json", status: "M" },
    ],
    added: 3,
    removed: 1,
    commits: 0,
    untilSha: null,
    laterBaselines: [],
    ...over,
  };
}

function diffOf(text: string): FileDiff {
  return {
    path: "a.ts",
    binary: false,
    tooLarge: false,
    hunks: [
      { header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: "add", text }] },
    ],
  };
}

/// Answers with whichever neutral key the request gave the card of that
/// title -- the keys are shuffled per request, so a fixed key would be
/// testing the shuffle.
function answering(title: string, confidence: number) {
  return (request: unknown) => {
    const criteria = (request as AttributionRequest).questions.owner.criteria;
    const key = Object.keys(criteria).find((k) => {
      const c = criteria[k];
      return typeof c === "object" && c.title === title;
    });
    return Promise.resolve({ answers: { owner: { choice: key ?? "none", confidence } } });
  };
}

function run(over: { cwd?: string; changes?: RunChanges } = {}) {
  return attributeRun({
    cardPath: SELF,
    cardTitle: "Self card",
    cwd: over.cwd ?? "/repo",
    changes: over.changes ?? changes(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
  attributionStore.set({});
  typesafeSettings.set({ enabled: false, hasKey: true, changeAttribution: true });
  kanbanState.set({ [WS]: board([binding(SELF), binding(PEER)]) });
  gavinTrees.set({ [WS]: tree([plan(SELF, "Self card"), plan(PEER, "Peer card")]) });
  vi.mocked(backend.readFileForViewer).mockImplementation((path) =>
    Promise.resolve({
      content: `---\ntitle: x\n---\n${path === PEER ? "Peer's plan: touch a.ts." : "Self's plan."}\n`,
      truncated: false,
      exists: true,
    })
  );
  vi.mocked(backend.gitDiffSince).mockResolvedValue(diffOf("const peer = 1;"));
  vi.mocked(backend.typesafeAttribution).mockImplementation(answering("Peer card", 0.9));
});

describe("the gates", () => {
  it("sends nothing while its own switch is off, whatever the turn verdict's says", async () => {
    typesafeSettings.set({ enabled: true, hasKey: true, changeAttribution: false });
    await run();
    expect(get(attributionStore)[KEY]).toEqual({ state: "skipped", reason: "TypeSafe change attribution is off." });
    expect(backend.gitDiffSince).not.toHaveBeenCalled();
    expect(backend.typesafeAttribution).not.toHaveBeenCalled();
    expect(backend.readFileForViewer).not.toHaveBeenCalled();
  });

  it("sends nothing without a key, and nothing before the settings were read", async () => {
    typesafeSettings.set({ enabled: false, hasKey: false, changeAttribution: true });
    await run();
    expect(get(attributionStore)[KEY]).toMatchObject({ state: "skipped", reason: expect.stringContaining("key") });
    typesafeSettings.set(null);
    await run();
    expect(get(attributionStore)[KEY].state).toBe("skipped");
    expect(backend.typesafeAttribution).not.toHaveBeenCalled();
  });

  it("asks nothing for a run with no co-tenant", async () => {
    kanbanState.set({ [WS]: board([binding(SELF)]) });
    await run();
    expect(get(attributionStore)[KEY]).toMatchObject({ state: "skipped", reason: expect.stringMatching(/no other card/i) });
    expect(backend.typesafeAttribution).not.toHaveBeenCalled();
    expect(backend.gitDiffSince).not.toHaveBeenCalled();
  });

  it("asks nothing about a run nobody could measure", async () => {
    await run({ changes: changes({ baseMissing: true, root: "/repo" }) });
    expect(get(attributionStore)[KEY].state).toBe("skipped");
    expect(backend.typesafeAttribution).not.toHaveBeenCalled();
  });
});

describe("one question per file", () => {
  it("offers the run's own card and its co-tenants, with their plans, and lands the answer", async () => {
    await run();
    // The lockfile is skipped in code: one file asked, one diff read.
    expect(backend.typesafeAttribution).toHaveBeenCalledTimes(1);
    expect(backend.gitDiffSince).toHaveBeenCalledTimes(1);
    expect(backend.gitDiffSince).toHaveBeenCalledWith("/repo", BASE, "a.ts", null, false, null);

    const request = vi.mocked(backend.typesafeAttribution).mock.calls[0][0] as AttributionRequest;
    expect(request.state.change.path).toBe("a.ts");
    expect(request.state.change.diff).toBe("@@ -1,1 +1,1 @@\n+const peer = 1;");
    const options = Object.values(request.questions.owner.criteria).filter((c) => typeof c === "object");
    expect(options).toEqual(
      expect.arrayContaining([
        { title: "Self card", description: "Self's plan." },
        { title: "Peer card", description: "Peer's plan: touch a.ts." },
      ])
    );
    expect(options).toHaveLength(2);

    const entry = get(attributionStore)[KEY];
    expect(entry).toEqual({
      state: "done",
      asked: 1,
      attribution: { "a.ts": { kind: "card", card: PEER, title: "Peer card", confidence: 0.9 } },
    });
    expect(ownersOf(entry)).toEqual(new Map([["a.ts", PEER]]));
  });

  it("reads the diff under the run's own bound", async () => {
    const later = "2222222222222222222222222222222222222222";
    await run({ changes: changes({ untilSha: later }) });
    expect(backend.gitDiffSince).toHaveBeenCalledWith("/repo", BASE, "a.ts", null, false, later);
    expect(get(attributionStore)[attributionKey(SELF, BASE, later)]?.state).toBe("done");
  });

  it("leaves a file unattributed when the request fails, and when the model is not sure", async () => {
    vi.mocked(backend.typesafeAttribution).mockRejectedValueOnce(new Error("TypeSafe answered 500"));
    await run();
    expect(get(attributionStore)[KEY]).toMatchObject({ state: "done", attribution: { "a.ts": UNATTRIBUTED } });

    attributionStore.set({});
    vi.mocked(backend.typesafeAttribution).mockImplementation(answering("Peer card", 0.5));
    await run();
    expect(get(attributionStore)[KEY]).toMatchObject({ state: "done", attribution: { "a.ts": UNATTRIBUTED } });
  });

  it("leaves a file unattributed when its diff cannot be read or has nothing to judge", async () => {
    vi.mocked(backend.gitDiffSince).mockRejectedValueOnce(new Error("no such path"));
    await run();
    expect(get(attributionStore)[KEY]).toMatchObject({ state: "done", attribution: { "a.ts": UNATTRIBUTED } });
    expect(backend.typesafeAttribution).not.toHaveBeenCalled();

    attributionStore.set({});
    vi.mocked(backend.gitDiffSince).mockResolvedValueOnce({ path: "a.ts", binary: true, tooLarge: false, hunks: [] });
    await run();
    expect(get(attributionStore)[KEY]).toMatchObject({ state: "done", attribution: { "a.ts": UNATTRIBUTED } });
    expect(backend.typesafeAttribution).not.toHaveBeenCalled();
  });

  it("does not ask twice about a file whose diff and options have not changed", async () => {
    await run();
    await run();
    expect(backend.typesafeAttribution).toHaveBeenCalledTimes(1);
    // ...but does ask again once the diff moved.
    vi.mocked(backend.gitDiffSince).mockResolvedValue(diffOf("const peer = 2;"));
    await run();
    expect(backend.typesafeAttribution).toHaveBeenCalledTimes(2);
  });

  it("drops a co-tenant whose card is no longer on the board, and asks nothing when none is left", async () => {
    gavinTrees.set({ [WS]: tree([plan(SELF, "Self card")]) });
    await run();
    expect(get(attributionStore)[KEY].state).toBe("skipped");
    expect(backend.typesafeAttribution).not.toHaveBeenCalled();
  });

  it("holds at most a few requests in flight", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, status: "M" as const }));
    let inFlight = 0;
    let peak = 0;
    vi.mocked(backend.typesafeAttribution).mockImplementation(async (request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return answering("Peer card", 0.9)(request);
    });
    await run({ changes: changes({ files: many }) });
    expect(backend.typesafeAttribution).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(ATTRIBUTION_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(get(attributionStore)[KEY]).toMatchObject({ state: "done", asked: 10 });
  });
});
