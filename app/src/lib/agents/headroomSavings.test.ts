import { describe, it, expect } from "vitest";
import {
  savedInWindow,
  savingsByProfile,
  savingsSince,
  windowSavingsLine,
  windowSavingsTip,
  windowStart,
  type RunSavings,
} from "$lib/agents/headroomSavings";
import type { UsageWindow } from "$lib/agents/agentUsage";

const HOUR = 3600;
const NOW = 1_757_000_000;

function fiveHour(resetsAt: number | null = NOW + 2 * HOUR): UsageWindow {
  return { id: "five_hour", label: "5-hour", usedPercent: 40, resetsAt };
}

function weekly(resetsAt: number | null = NOW + 3 * 24 * HOUR): UsageWindow {
  return { id: "seven_day", label: "Weekly", usedPercent: 20, resetsAt };
}

function saving(over: Partial<RunSavings> = {}): RunSavings {
  return {
    workspaceId: "ws-a",
    path: "/a/plans/t.md",
    sessionId: "s-1",
    startedAt: NOW - HOUR,
    endedAt: NOW - 30 * 60,
    tokensSaved: 1_000,
    requests: 4,
    ...over,
  };
}

describe("windowStart", () => {
  it("is the reset minus the window's length", () => {
    expect(windowStart(fiveHour(NOW + 2 * HOUR))).toBe(NOW - 3 * HOUR);
    expect(windowStart(weekly(NOW + 3 * 24 * HOUR))).toBe(NOW - 4 * 24 * HOUR);
    // Codex names its two windows by rank, with the same lengths.
    expect(windowStart({ ...fiveHour(), id: "primary" })).toBe(NOW - 3 * HOUR);
    expect(windowStart({ ...weekly(), id: "secondary" })).toBe(NOW - 4 * 24 * HOUR);
  });

  it("has no start when the reset is unknown", () => {
    expect(windowStart(fiveHour(null))).toBeNull();
  });

  it("has no start for a window whose length gavin does not know", () => {
    // A spend limit is billed over a month gavin cannot see the start
    // of, and an unrecognised id could be any length. A guessed start
    // would sum savings from outside the window.
    expect(windowStart({ ...weekly(), id: "spend_limit" })).toBeNull();
    expect(windowStart({ ...fiveHour(), id: "something_new" })).toBeNull();
  });
});

describe("savedInWindow", () => {
  const all = new Set(["ws-a", "ws-b"]);

  it("sums the runs that ended inside the window", () => {
    const runs = [
      saving({ sessionId: "s-1", tokensSaved: 1_000, requests: 4 }),
      saving({ sessionId: "s-2", tokensSaved: 2_500, requests: 6, endedAt: NOW - 2 * HOUR }),
      // Ended before this 5-hour window began: last window's saving.
      saving({ sessionId: "s-old", tokensSaved: 99_000, endedAt: NOW - 4 * HOUR }),
    ];
    expect(savedInWindow(runs, fiveHour(), all)).toEqual({ tokens: 3_500, requests: 10, runs: 2 });
  });

  it("places a run at its end, however long before the window it started", () => {
    const longRun = saving({ startedAt: NOW - 10 * HOUR, endedAt: NOW - HOUR });
    expect(savedInWindow([longRun], fiveHour(), all)?.runs).toBe(1);
  });

  it("counts a session once, however many cards it was bound to", () => {
    const runs = [
      saving({ sessionId: "s-1", path: "/a/plans/one.md", tokensSaved: 1_000 }),
      saving({ sessionId: "s-1", path: "/a/plans/two.md", tokensSaved: 1_000 }),
    ];
    expect(savedInWindow(runs, fiveHour(), all)).toEqual({ tokens: 1_000, requests: 4, runs: 1 });
  });

  it("counts only the workspaces that run this agent", () => {
    const runs = [
      saving({ sessionId: "s-a", workspaceId: "ws-a", tokensSaved: 1_000 }),
      saving({ sessionId: "s-b", workspaceId: "ws-b", tokensSaved: 5_000 }),
    ];
    expect(savedInWindow(runs, fiveHour(), new Set(["ws-b"]))?.tokens).toBe(5_000);
  });

  it("is an empty sum, not an unknown, when nothing ended in the window", () => {
    expect(savedInWindow([], fiveHour(), all)).toEqual({ tokens: 0, requests: 0, runs: 0 });
  });

  it("is unknown when the window's start is", () => {
    expect(savedInWindow([saving()], fiveHour(null), all)).toBeNull();
    expect(savedInWindow([saving()], { ...weekly(), id: "spend_limit" }, all)).toBeNull();
  });

  it("skips a run whose end nobody recorded", () => {
    expect(savedInWindow([saving({ endedAt: null })], fiveHour(), all)?.runs).toBe(0);
  });
});

describe("the hub's line", () => {
  it("says what was saved in the window, rounded", () => {
    expect(windowSavingsLine({ tokens: 341_200, requests: 90, runs: 4 })).toBe("saved 341k");
  });

  it("says nothing when no compressed run ended in the window", () => {
    // A workspace that never turned compression on must not grow a
    // "saved 0" on every usage row.
    expect(windowSavingsLine({ tokens: 0, requests: 0, runs: 0 })).toBeNull();
    expect(windowSavingsLine(null)).toBeNull();
  });

  it("keeps a real zero: runs were compressed and saved nothing", () => {
    expect(windowSavingsLine({ tokens: 0, requests: 3, runs: 1 })).toBe("saved 0");
  });

  it("spells the figure out in the tooltip, with the window it belongs to", () => {
    expect(windowSavingsTip({ tokens: 341_200, requests: 90, runs: 4 }, fiveHour())).toBe(
      "Headroom saved 341,200 tokens over 90 requests, in 4 card runs that ended in this 5-hour window"
    );
    expect(windowSavingsTip({ tokens: 812, requests: 1, runs: 1 }, fiveHour())).toBe(
      "Headroom saved 812 tokens over 1 request, in 1 card run that ended in this 5-hour window"
    );
  });
});

describe("savingsSince", () => {
  it("reaches back to the earliest window the hub shows", () => {
    expect(savingsSince([fiveHour(), weekly(), null])).toBe(NOW - 4 * 24 * HOUR);
  });

  it("asks for nothing when no window has a known start", () => {
    expect(savingsSince([])).toBeNull();
    expect(savingsSince([null, fiveHour(null), { ...weekly(), id: "spend_limit" }])).toBeNull();
  });
});

describe("savingsByProfile", () => {
  it("gives each usage row its own window's saving, over the workspaces running its agent", () => {
    const runs = [
      saving({ sessionId: "s-claude", workspaceId: "ws-a", tokensSaved: 1_000 }),
      saving({ sessionId: "s-codex", workspaceId: "ws-b", tokensSaved: 7_000 }),
    ];
    const rows = [
      { profileId: "claude-code", worst: fiveHour() },
      { profileId: "codex", worst: weekly() },
      { profileId: "gemini", worst: null },
    ];
    const byWorkspace = { "ws-a": "claude-code", "ws-b": "codex", "ws-c": null };

    const out = savingsByProfile(rows, byWorkspace, runs);

    expect(out["claude-code"]).toEqual({ tokens: 1_000, requests: 4, runs: 1 });
    expect(out["codex"]).toEqual({ tokens: 7_000, requests: 4, runs: 1 });
    expect(out["gemini"]).toBeNull();
  });

  it("is unknown for every row until the snapshots have been read", () => {
    const out = savingsByProfile([{ profileId: "claude-code", worst: fiveHour() }], { "ws-a": "claude-code" }, null);
    expect(out["claude-code"]).toBeNull();
  });
});
