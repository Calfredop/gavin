import { describe, it, expect } from "vitest";
import {
  agentLabel,
  formatDuration,
  formatTokens,
  historyBlockedReason,
  historySummary,
  outcomeLabel,
  outcomeSentence,
  runRows,
  runSeconds,
  tokenBreakdown,
  tokenProblem,
  tokenSummary,
  totalCost,
  type CardRun,
  type TokenReport,
} from "./runHistory";
import type { DaemonCompat } from "./daemonCompat";

const NOW = 1_757_000_000;

function run(over: Partial<CardRun> = {}): CardRun {
  return {
    id: 1,
    path: "/p/t.md",
    sessionId: "s-1",
    command: "claude --session-id conv-1",
    conversationId: "conv-1",
    launchCwd: "/p",
    baseSha: null,
    startedAt: NOW - 600,
    endedAt: NOW - 300,
    exitCode: 0,
    outcome: "exited",
    resumeAttempts: null,
    ...over,
  };
}

function compat(daemonVersion: number): DaemonCompat {
  return { daemonVersion, appVersion: 27, band: "parity", floor: 5 } as unknown as DaemonCompat;
}

describe("formatDuration", () => {
  it("never rounds a short run down to nothing", () => {
    // A column of "0m" is what a panel of quick runs turns into if
    // minutes are the floor.
    expect(formatDuration(9)).toBe("9s");
    expect(formatDuration(0.4)).toBe("1s");
  });

  it("drops to whole minutes and then to hours and minutes", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(4 * 60 + 30)).toBe("4m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3600 + 12 * 60)).toBe("1h 12m");
  });

  it("has a dash for a duration that is not one", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("shortens at each order of magnitude without inventing precision", () => {
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(41_200)).toBe("41k");
    expect(formatTokens(1_400_000)).toBe("1.4M");
  });
});

describe("runSeconds", () => {
  it("measures a finished run against its recorded end", () => {
    expect(runSeconds(run({ startedAt: 100, endedAt: 460 }), NOW)).toBe(360);
  });

  it("measures a running run against now", () => {
    expect(runSeconds(run({ startedAt: NOW - 120, endedAt: null, outcome: "running" }), NOW)).toBe(120);
  });

  /// The case the whole `abandoned` outcome exists for. Measuring
  /// against now would report a run that stopped days ago as a
  /// multi-day session, which is the single most misleading number this
  /// panel could show.
  it("gives no duration at all for a run whose end nobody watched", () => {
    expect(runSeconds(run({ startedAt: NOW - 400_000, endedAt: null, outcome: "abandoned" }), NOW)).toBe(null);
  });
});

describe("outcomes", () => {
  it("says what was observed, and an exit code when there is one", () => {
    expect(outcomeSentence(run({ outcome: "exited", exitCode: 0 }))).toBe("The session ended cleanly.");
    expect(outcomeSentence(run({ outcome: "exited", exitCode: 130 }))).toContain("exit code 130");
    expect(outcomeLabel(run({ outcome: "exited", exitCode: 130 }))).toBe("Exit 130");
    expect(outcomeLabel(run({ outcome: "exited", exitCode: 0 }))).toBe("Finished");
  });

  /// An unlink is not an exit: the session may well still be running,
  /// and saying otherwise would invent an ending.
  it("does not claim a session ended when only the binding did", () => {
    expect(outcomeSentence(run({ outcome: "unlinked" }))).toContain("may have carried on running");
    expect(outcomeLabel(run({ outcome: "unlinked" }))).toBe("Unbound");
  });

  it("says an unwatched run's end was not recorded", () => {
    expect(outcomeSentence(run({ outcome: "abandoned" }))).toContain("not recorded");
  });

  it("has an answer for an outcome it has never heard of", () => {
    expect(outcomeLabel(run({ outcome: "something-new" }))).toBe("Unknown");
    expect(outcomeSentence(run({ outcome: "something-new" }))).toContain("no record");
  });
});

describe("agentLabel", () => {
  it("is the command's own name, path and arguments stripped", () => {
    expect(agentLabel(run({ command: "/opt/homebrew/bin/claude --session-id x 'go'" }))).toBe("claude");
    expect(agentLabel(run({ command: "codex resume abc" }))).toBe("codex");
  });

  it("is null rather than a guess when no command was recorded", () => {
    expect(agentLabel(run({ command: null }))).toBe(null);
    expect(agentLabel(run({ command: "   " }))).toBe(null);
  });
});

describe("runRows", () => {
  /// Gavin resumes a card into a NEW session carrying the previous
  /// run's conversation id. The daemon files that as a new run --
  /// correctly, it is a new session -- and reading it back as a second
  /// attempt at the CARD would tell somebody they ran it twice when
  /// they pressed Resume once.
  it("counts a resume chain as one run, numbered oldest first", () => {
    const runs = [
      run({ id: 3, sessionId: "s-3", conversationId: "conv-2" }),
      run({ id: 2, sessionId: "s-2", conversationId: "conv-1" }),
      run({ id: 1, sessionId: "s-1", conversationId: "conv-1" }),
    ];

    const rows = runRows(runs, NOW);

    // Newest first, exactly as it arrived from the daemon.
    expect(rows.map((r) => r.run.id)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.number)).toEqual([2, 1, 1]);
    expect(rows.map((r) => r.resumed)).toEqual([false, true, false]);
    expect(rows.map((r) => r.label)).toEqual(["Run 2", "Run 1 · resume 1", "Run 1"]);
  });

  /// Adjacency, not the id alone. A conversation resumed, superseded by
  /// fresh work, then resumed again is two pieces of work -- merging
  /// them on the shared id would file the newer one under the older
  /// one's number.
  it("does not merge two stretches of one conversation across a run between them", () => {
    const runs = [
      run({ id: 3, sessionId: "s-3", conversationId: "conv-1" }),
      run({ id: 2, sessionId: "s-2", conversationId: "conv-2" }),
      run({ id: 1, sessionId: "s-1", conversationId: "conv-1" }),
    ];

    const rows = runRows(runs, NOW);

    expect(rows.map((r) => r.number)).toEqual([3, 2, 1]);
    expect(rows.every((r) => !r.resumed)).toBe(true);
  });

  /// Two runs with no conversation id at all are two runs. Treating
  /// null as a shared value would chain every legacy row into one.
  it("never chains runs that have no conversation id", () => {
    const runs = [
      run({ id: 2, sessionId: "s-2", conversationId: null }),
      run({ id: 1, sessionId: "s-1", conversationId: null }),
    ];

    expect(runRows(runs, NOW).map((r) => r.number)).toEqual([2, 1]);
  });

  it("carries the duration, or nothing when there is none", () => {
    const rows = runRows(
      [
        run({ id: 2, startedAt: NOW - 400_000, endedAt: null, outcome: "abandoned", conversationId: "c-2" }),
        run({ id: 1, startedAt: NOW - 3600, endedAt: NOW - 3000, conversationId: "c-1" }),
      ],
      NOW
    );

    expect(rows[0].duration).toBe(null);
    expect(rows[1].duration).toBe("10m");
  });
});

describe("historySummary", () => {
  it("says a card nobody has run has no runs, not zero of them", () => {
    expect(historySummary([], NOW)).toBe("No runs yet");
  });

  it("counts runs, not sessions, and names the sessions separately", () => {
    const runs = [
      run({ id: 2, sessionId: "s-2", conversationId: "conv-1", startedAt: NOW - 200, endedAt: NOW - 100 }),
      run({ id: 1, sessionId: "s-1", conversationId: "conv-1", startedAt: NOW - 600, endedAt: NOW - 300 }),
    ];

    expect(historySummary(runs, NOW)).toBe("1 run · 2 sessions · 6m");
  });

  /// Summing only the measurable runs and presenting the total as the
  /// card's would under-report by exactly the runs nobody watched, so
  /// the count of what WAS measured is part of the sentence.
  it("says how many runs the total covers when it cannot cover them all", () => {
    const runs = [
      run({ id: 2, sessionId: "s-2", conversationId: "c-2", endedAt: null, outcome: "abandoned" }),
      run({ id: 1, sessionId: "s-1", conversationId: "c-1", startedAt: NOW - 600, endedAt: NOW - 300 }),
    ];

    expect(historySummary(runs, NOW)).toBe("2 runs · 5m over 1");
  });
});

describe("historyBlockedReason", () => {
  it("blames the daemon for the missing history, never the card", () => {
    const reason = historyBlockedReason(compat(26));
    expect(reason).toContain("daemon v27");
    expect(reason).toContain("Restart the daemon");
  });

  it("is null once the daemon can answer", () => {
    expect(historyBlockedReason(compat(27))).toBe(null);
    expect(historyBlockedReason(null)).toBe(null);
  });
});

describe("token reports", () => {
  const ready: TokenReport = {
    kind: "ready",
    totals: {
      inputTokens: 1200,
      outputTokens: 8400,
      cacheReadTokens: 402_000,
      cacheWriteTokens: 26_000,
      totalTokens: 437_600,
      turns: 14,
    },
    models: ["claude-opus-5"],
  };

  it("reduces a reading to one line and keeps the exact figures for the tooltip", () => {
    expect(tokenSummary(ready)).toBe("438k tokens · 14 turns");
    expect(tokenBreakdown(ready)).toContain("Cache read 402,000");
    expect(tokenBreakdown(ready)).toContain("claude-opus-5");
  });

  /// A summary and a reason must never come out of the same slot, or a
  /// profile gavin cannot read renders as a run that cost nothing.
  it("gives a reason instead of a number when there is no reading", () => {
    const none: TokenReport = { kind: "unsupported", reason: "gavin cannot read gemini's token counts" };
    expect(tokenSummary(none)).toBe(null);
    expect(tokenProblem(none)).toBe("gavin cannot read gemini's token counts");
    expect(tokenProblem(ready)).toBe(null);
  });

  it("has nothing to say about a report that has not arrived", () => {
    expect(tokenSummary(null)).toBe(null);
    expect(tokenProblem(null)).toBe(null);
  });
});

describe("totalCost", () => {
  const of = (total: number): TokenReport => ({
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
  });

  it("sums what could be read", () => {
    expect(totalCost([of(1000), of(2000)])).toBe("3.0k tokens");
  });

  /// A card total that silently omits the runs it could not read is a
  /// number somebody will compare against their bill.
  it("says how much of the card the total actually covers", () => {
    expect(totalCost([of(1000), { kind: "unavailable", reason: "gone" }])).toBe(
      "1.0k tokens over 1 of 2 runs"
    );
  });

  it("is null rather than zero when nothing could be read", () => {
    expect(totalCost([null, { kind: "unsupported", reason: "no" }])).toBe(null);
  });
});
