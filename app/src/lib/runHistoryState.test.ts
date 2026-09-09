import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/backend", () => ({
  cardRuns: vi.fn(),
  cardRunTokens: vi.fn(),
}));

import * as backend from "$lib/backend";
import {
  closeRunHistory,
  historyFor,
  openRunHistory,
  refreshRunHistory,
  runHistoryStore,
  tokensForRun,
} from "$lib/runHistoryState";
import type { CardRun, TokenReport } from "$lib/runHistory";

const PATH = "/ws/.gavin-root/plans/t.md";
const WS = "ws-1";

function run(over: Partial<CardRun> = {}): CardRun {
  return {
    id: 1,
    path: PATH,
    sessionId: "s-1",
    command: "claude",
    conversationId: "conv-1",
    launchCwd: "/ws",
    baseSha: null,
    startedAt: 1000,
    endedAt: 1600,
    exitCode: 0,
    outcome: "exited",
    resumeAttempts: null,
    ...over,
  };
}

function ready(total: number): TokenReport {
  return {
    kind: "ready",
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: total,
      turns: 1,
    },
    models: [],
  };
}

describe("runHistoryState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runHistoryStore.set({});
    vi.mocked(backend.cardRunTokens).mockResolvedValue(ready(100));
  });

  it("loads a card's runs and each run's cost", async () => {
    vi.mocked(backend.cardRuns).mockResolvedValue([run()]);

    await openRunHistory(PATH, WS, "claude-code");

    const view = historyFor(PATH);
    expect(view?.runs).toHaveLength(1);
    expect(view?.loading).toBe(false);
    expect(tokensForRun(view, run())).toEqual(ready(100));
  });

  /// Two sessions of one resume chain share a conversation id, and a
  /// transcript is filed under that id -- asking twice would double the
  /// disk work to show the same number twice.
  it("reads one transcript per conversation, not one per run", async () => {
    vi.mocked(backend.cardRuns).mockResolvedValue([
      run({ id: 2, sessionId: "s-2", conversationId: "conv-1" }),
      run({ id: 1, sessionId: "s-1", conversationId: "conv-1" }),
    ]);

    await openRunHistory(PATH, WS, "claude-code");

    expect(backend.cardRunTokens).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing when a run carries no conversation id", async () => {
    vi.mocked(backend.cardRuns).mockResolvedValue([run({ conversationId: null })]);

    await openRunHistory(PATH, WS, "claude-code");

    expect(backend.cardRunTokens).not.toHaveBeenCalled();
    expect(tokensForRun(historyFor(PATH), run({ conversationId: null }))).toBe(null);
  });

  /// A finished run's transcript cannot change, so a refresh must not
  /// re-read it -- but a RUNNING one's is still growing, and a cached
  /// figure there would be the one number on the panel that never moves.
  it("re-reads a running run's cost on refresh and leaves finished ones alone", async () => {
    vi.mocked(backend.cardRuns).mockResolvedValue([
      run({ id: 2, sessionId: "s-2", conversationId: "conv-live", endedAt: null, outcome: "running" }),
      run({ id: 1, sessionId: "s-1", conversationId: "conv-done" }),
    ]);
    await openRunHistory(PATH, WS, "claude-code");
    expect(backend.cardRunTokens).toHaveBeenCalledTimes(2);
    vi.mocked(backend.cardRunTokens).mockClear();

    await refreshRunHistory(PATH, WS, "claude-code");

    expect(backend.cardRunTokens).toHaveBeenCalledTimes(1);
    expect(vi.mocked(backend.cardRunTokens).mock.calls[0][1]).toBe("conv-live");
  });

  /// A failure to read ONE run's cost is a fact about that run. Letting
  /// it reach the panel's error strip would blank a history that loaded
  /// perfectly well.
  it("keeps a token failure on the run it belongs to", async () => {
    vi.mocked(backend.cardRuns).mockResolvedValue([run()]);
    vi.mocked(backend.cardRunTokens).mockRejectedValue(new Error("no such file"));

    await openRunHistory(PATH, WS, "claude-code");

    const view = historyFor(PATH);
    expect(view?.error).toBe(null);
    expect(view?.runs).toHaveLength(1);
    expect(tokensForRun(view, run())).toMatchObject({ kind: "unavailable" });
  });

  it("reports a failure to read the runs themselves as the panel's error", async () => {
    vi.mocked(backend.cardRuns).mockRejectedValue(new Error("daemon is v26"));

    await openRunHistory(PATH, WS, "claude-code");

    expect(historyFor(PATH)?.error).toContain("daemon is v26");
    expect(historyFor(PATH)?.loading).toBe(false);
  });

  /// Reopening a panel that flashes empty and then fills reads as a card
  /// that lost its history -- the one thing this feature must never
  /// suggest.
  it("keeps the rows it already had while a reopen is in flight", async () => {
    vi.mocked(backend.cardRuns).mockResolvedValue([run()]);
    await openRunHistory(PATH, WS, "claude-code");

    let seen: CardRun[] | null = null;
    vi.mocked(backend.cardRuns).mockImplementation(async () => {
      seen = get(runHistoryStore)[PATH]?.runs ?? null;
      return [run()];
    });
    await openRunHistory(PATH, WS, "claude-code");

    expect(seen).toHaveLength(1);
  });

  /// The token counter, not object identity: Svelte 5 proxies `$state`,
  /// so a stored value is never identity-equal to the one put in.
  it("drops the result of a fetch a later one has superseded", async () => {
    let release!: (runs: CardRun[]) => void;
    const slow = new Promise<CardRun[]>((resolve) => {
      release = resolve;
    });
    vi.mocked(backend.cardRuns).mockImplementationOnce(() => slow);
    const first = openRunHistory(PATH, WS, "claude-code");

    vi.mocked(backend.cardRuns).mockResolvedValue([run({ id: 9, sessionId: "s-9" })]);
    await refreshRunHistory(PATH, WS, "claude-code");
    release([run({ id: 1, sessionId: "s-stale" })]);
    await first;

    expect(historyFor(PATH)?.runs.map((r) => r.sessionId)).toEqual(["s-9"]);
  });

  it("forgets a card once its panel closes", async () => {
    vi.mocked(backend.cardRuns).mockResolvedValue([run()]);
    await openRunHistory(PATH, WS, "claude-code");

    closeRunHistory(PATH);

    expect(historyFor(PATH)).toBeUndefined();
  });
});
