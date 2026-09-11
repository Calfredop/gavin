import { describe, expect, it } from "vitest";
import {
  type AgentUsageReport,
  type UsageWindow,
  USAGE_CACHE_KEY,
  barPercent,
  displayPercent,
  dropExpiredWindows,
  formatDuration,
  formatObservedAge,
  formatResetsIn,
  loadUsageCache,
  parseUsageCache,
  pruneUsageCache,
  reportSeverity,
  saveUsageCache,
  usageBlock,
  usageForLaunchGate,
  usageSeverity,
  usageSummary,
  unavailableReason,
  worstWindow,
} from "$lib/agents/agentUsage";

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function window(over: Partial<UsageWindow> = {}): UsageWindow {
  return { id: "five_hour", label: "5-hour", usedPercent: 10, resetsAt: NOW_S + 3600, ...over };
}

function ready(windows: UsageWindow[], over: Partial<Extract<AgentUsageReport, { state: "ready" }>> = {}): AgentUsageReport {
  return { state: "ready", windows, plan: null, observedAt: NOW_S, cached: false, ...over };
}

describe("usageSeverity", () => {
  it("bands on the two shared boundaries", () => {
    expect(usageSeverity(0)).toBe("ok");
    expect(usageSeverity(74.9)).toBe("ok");
    expect(usageSeverity(75)).toBe("warn");
    expect(usageSeverity(89.9)).toBe("warn");
    expect(usageSeverity(90)).toBe("critical");
    expect(usageSeverity(137)).toBe("critical");
  });

  it("treats a non-number as no cause for alarm rather than as full", () => {
    expect(usageSeverity(Number.NaN)).toBe("ok");
  });
});

describe("worstWindow", () => {
  it("picks the window nearest its ceiling, not the first", () => {
    const report = ready([
      window({ id: "five_hour", usedPercent: 30 }),
      window({ id: "seven_day", label: "Weekly", usedPercent: 95 }),
    ]);
    expect(worstWindow(report)?.id).toBe("seven_day");
    expect(reportSeverity(report)).toBe("critical");
  });

  /// "gavin cannot see" must never render in the same colour as "plenty
  /// left", so a report with no numbers has no severity at all.
  it("has no severity when there is nothing to read", () => {
    expect(reportSeverity({ state: "unsupported" })).toBeNull();
    expect(reportSeverity({ state: "unavailable", reason: "x", retryAfter: null })).toBeNull();
    expect(reportSeverity(ready([]))).toBeNull();
  });
});

describe("percentages", () => {
  /// Rounding UP would let a bar claim 100% while the window still has
  /// room -- the one error that makes the panel disagree with the agent.
  it("rounds down for display", () => {
    expect(displayPercent(99.9)).toBe(99);
    expect(displayPercent(0.4)).toBe(0);
    expect(displayPercent(-5)).toBe(0);
  });

  it("clamps the bar but not the number", () => {
    expect(displayPercent(137.5)).toBe(137);
    expect(barPercent(137.5)).toBe(100);
    expect(barPercent(-3)).toBe(0);
  });
});

describe("formatDuration", () => {
  it("reads in the pair of units the wait deserves", () => {
    expect(formatDuration(30)).toBe("under a minute");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(59 * 60)).toBe("59m");
    expect(formatDuration(2 * 3600)).toBe("2h");
    expect(formatDuration(2 * 3600 + 14 * 60)).toBe("2h 14m");
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(formatDuration(-10)).toBe("under a minute");
  });
});

describe("formatResetsIn", () => {
  it("reports the wait from an absolute instant", () => {
    expect(formatResetsIn(NOW_S + 2 * 3600 + 14 * 60, NOW_MS)).toBe("resets in 2h 14m");
  });

  /// The host drops expired windows, so one seen here crossed while the
  /// panel was open. A negative duration would be nonsense.
  it("says a crossed window is resetting rather than counting backwards", () => {
    expect(formatResetsIn(NOW_S - 5, NOW_MS)).toBe("resetting now");
  });

  it("stays null when the route gave no instant", () => {
    expect(formatResetsIn(null, NOW_MS)).toBeNull();
    expect(formatResetsIn(undefined, NOW_MS)).toBeNull();
  });
});

describe("formatObservedAge", () => {
  /// Stamping "0m ago" on a live reading trains people to ignore the
  /// stamp, so a fresh one carries none.
  it("is silent under a minute and explicit after", () => {
    expect(formatObservedAge(NOW_S - 10, NOW_MS)).toBeNull();
    expect(formatObservedAge(NOW_S - 3 * 3600, NOW_MS)).toBe("3h ago");
  });
});

describe("usageSummary", () => {
  it("names the worst window with its clock", () => {
    const report = ready([
      window({ usedPercent: 12 }),
      window({ id: "seven_day", label: "Weekly", usedPercent: 88, resetsAt: NOW_S + 86400 }),
    ]);
    expect(usageSummary(report, NOW_MS)).toBe("Weekly 88%, resets in 1d");
  });

  it("omits the clock a route did not give", () => {
    expect(usageSummary(ready([window({ usedPercent: 5, resetsAt: null })]), NOW_MS)).toBe(
      "5-hour 5%"
    );
  });

  it("has nothing to say without numbers", () => {
    expect(usageSummary({ state: "unsupported" }, NOW_MS)).toBeNull();
  });
});

describe("unavailableReason", () => {
  it("distinguishes an agent with no route from one that did not answer", () => {
    expect(unavailableReason({ state: "unsupported" }, "Gemini CLI", NOW_MS)).toBe(
      "Gemini CLI does not publish its limits anywhere gavin can read."
    );
  });

  /// A park is gavin waiting, not a window resetting, and saying "resets
  /// in" would claim the account is capped when it is not.
  it("reads a park as gavin retrying, not as a reset", () => {
    const report: AgentUsageReport = {
      state: "unavailable",
      reason: "the usage endpoint rate-limited gavin",
      retryAfter: NOW_S + 15 * 60,
    };
    expect(unavailableReason(report, "Claude Code", NOW_MS)).toBe(
      "the usage endpoint rate-limited gavin — trying again in 15m."
    );
  });

  it("stays out of the way of a ready report", () => {
    expect(unavailableReason(ready([window()]), "Claude Code", NOW_MS)).toBeNull();
  });
});

describe("usageBlock", () => {
  it("does not block below the threshold", () => {
    expect(usageBlock(ready([window({ usedPercent: 80 })]), 95).blocked).toBe(false);
  });

  it("blocks at the threshold and names the window", () => {
    const block = usageBlock(ready([window({ usedPercent: 95 })]), 95);
    expect(block.blocked).toBe(true);
    expect(block.window?.id).toBe("five_hour");
    expect(block.until).toBe(NOW_S + 3600);
  });

  /// Clearing the 5-hour window while the weekly is still over does not
  /// let work start, so the resume instant is the LATER reset.
  it("waits for the last blocking window, not the first", () => {
    const block = usageBlock(
      ready([
        window({ id: "five_hour", usedPercent: 96, resetsAt: NOW_S + 3600 }),
        window({ id: "seven_day", usedPercent: 99, resetsAt: NOW_S + 86400 }),
      ]),
      95
    );
    expect(block.until).toBe(NOW_S + 86400);
    expect(block.window?.id).toBe("seven_day");
  });

  /// A blocking window with no reset instant is a hold with no clock.
  /// Reporting some other window's reset would arm a resume that fires
  /// into a wall.
  it("has no clock when a blocking window gave none", () => {
    const block = usageBlock(
      ready([
        window({ id: "five_hour", usedPercent: 96, resetsAt: NOW_S + 3600 }),
        window({ id: "seven_day", usedPercent: 97, resetsAt: null }),
      ]),
      95
    );
    expect(block.blocked).toBe(true);
    expect(block.until).toBeNull();
  });

  /// Cursor's Auto and Other-Models pools are alternatives, not stacked
  /// windows. A full API bar must not refuse an `agent` launch whose Auto
  /// window still has room — that is the number the dashboard headline
  /// and the CLI actually spend.
  it("gates a Cursor launch on Auto, not the Other-Models pool", () => {
    const report = ready([
      window({ id: "total", label: "Total", usedPercent: 45, resetsAt: null }),
      window({ id: "auto", label: "Auto", usedPercent: 45, resetsAt: null }),
      window({ id: "api", label: "API", usedPercent: 100, resetsAt: null }),
    ]);
    expect(usageBlock(report, 90).blocked).toBe(true);
    expect(usageBlock(usageForLaunchGate("cursor", report), 90).blocked).toBe(false);
    expect(usageBlock(usageForLaunchGate("claude-code", report), 90).blocked).toBe(true);
    const enterprise = ready([
      window({ id: "total", label: "Total", usedPercent: 45, resetsAt: null }),
      window({ id: "api", label: "API", usedPercent: 100, resetsAt: null }),
    ]);
    expect(usageBlock(usageForLaunchGate("cursor", enterprise), 90).blocked).toBe(false);
  });

  /// Gavin not knowing is not evidence of a limit. A failed read that
  /// paused a rail would turn a network blip into a stopped workspace.
  it("never blocks on a report it could not read", () => {
    expect(usageBlock({ state: "unsupported" }, 1).blocked).toBe(false);
    expect(
      usageBlock({ state: "unavailable", reason: "offline", retryAfter: null }, 1).blocked
    ).toBe(false);
  });
});

describe("the persisted usage cache", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  /// A window whose reset has passed is the last value of a closed
  /// epoch, not a live reading. Showing 96% after the window reopened
  /// is the one lie this cache must not tell on restart.
  it("drops a window once its reset has passed", () => {
    const report = ready([
      window({ id: "five_hour", usedPercent: 96, resetsAt: NOW_S - 10 }),
      window({ id: "seven_day", label: "Weekly", usedPercent: 41, resetsAt: NOW_S + 3600 }),
    ]);
    const kept = dropExpiredWindows(report, NOW_MS);
    expect(kept?.state).toBe("ready");
    if (kept?.state !== "ready") return;
    expect(kept.windows).toHaveLength(1);
    expect(kept.windows[0].id).toBe("seven_day");
  });

  it("returns the same object when every window is still open", () => {
    const report = ready([window()]);
    expect(dropExpiredWindows(report, NOW_MS)).toBe(report);
  });

  /// Every window expired means there is nothing true to show. An empty
  /// ready report would render as "0%" and that is worse than absence.
  it("drops a report whose every window has reset", () => {
    const report = ready([window({ resetsAt: NOW_S - 1 })]);
    expect(dropExpiredWindows(report, NOW_MS)).toBeNull();
  });

  it("keeps a window that never said when it resets", () => {
    const report = ready([window({ resetsAt: null })]);
    expect(dropExpiredWindows(report, NOW_MS)).toBe(report);
  });

  it("leaves non-ready reports alone", () => {
    const unavailable: AgentUsageReport = {
      state: "unavailable",
      reason: "offline",
      retryAfter: null,
    };
    expect(dropExpiredWindows(unavailable, NOW_MS)).toBe(unavailable);
  });

  it("omits expired profiles and keeps the object when nothing changed", () => {
    const live = ready([window()]);
    const all = {
      "claude-code": live,
      codex: ready([window({ resetsAt: NOW_S - 1 })]),
    };
    const pruned = pruneUsageCache(all, NOW_MS);
    expect(pruned).not.toBe(all);
    expect(pruned["claude-code"]).toBe(live);
    expect(pruned.codex).toBeUndefined();
    const one = { "claude-code": live };
    expect(pruneUsageCache(one, NOW_MS)).toBe(one);
  });

  it("round-trips last known ready readings and marks them cached", () => {
    const storage = fakeStorage();
    const report = ready(
      [window({ usedPercent: 23.5, resetsAt: NOW_S + 3600 })],
      { plan: "max", observedAt: NOW_S - 120 }
    );
    saveUsageCache({ "claude-code": report }, storage, NOW_MS);
    const loaded = loadUsageCache(NOW_MS, storage);
    expect(loaded["claude-code"]).toEqual({ ...report, cached: true });
  });

  it("does not persist a reading that has already reset", () => {
    const storage = fakeStorage();
    saveUsageCache(
      { "claude-code": ready([window({ resetsAt: NOW_S - 1 })]) },
      storage,
      NOW_MS
    );
    expect(storage.map.has(USAGE_CACHE_KEY)).toBe(false);
  });

  it("clears the key rather than storing an empty object", () => {
    const storage = fakeStorage();
    storage.setItem(USAGE_CACHE_KEY, "{}");
    saveUsageCache({}, storage, NOW_MS);
    expect(storage.map.has(USAGE_CACHE_KEY)).toBe(false);
  });

  it("remembers nothing when there is no storage at all", () => {
    expect(loadUsageCache(NOW_MS, undefined)).toEqual({});
    expect(() => saveUsageCache({ a: ready([window()]) }, undefined, NOW_MS)).not.toThrow();
  });

  it("does not persist unsupported or unavailable answers", () => {
    const storage = fakeStorage();
    saveUsageCache(
      {
        custom: { state: "unsupported" },
        gemini: { state: "unavailable", reason: "offline", retryAfter: null },
      },
      storage,
      NOW_MS
    );
    expect(storage.map.has(USAGE_CACHE_KEY)).toBe(false);
  });

  /// Hand-edited or half-written cache must read as nothing rather than
  /// crash the sidebar or invent a 0% bar.
  it("drops anything it cannot trust", () => {
    expect(parseUsageCache(null, NOW_MS)).toEqual({});
    expect(parseUsageCache("not json", NOW_MS)).toEqual({});
    expect(parseUsageCache("[]", NOW_MS)).toEqual({});
    expect(parseUsageCache(JSON.stringify({ "claude-code": { state: "ready" } }), NOW_MS)).toEqual(
      {}
    );
    expect(
      parseUsageCache(
        JSON.stringify({
          "claude-code": {
            state: "ready",
            windows: [{ id: "five_hour", label: "5-hour", usedPercent: "full", resetsAt: null }],
            observedAt: NOW_S,
            cached: false,
          },
        }),
        NOW_MS
      )
    ).toEqual({});
  });
});
