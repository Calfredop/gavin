import { describe, it, expect } from "vitest";
import type { AgentUsageReport, UsageWindow } from "$lib/agentUsage";
import {
  CLEAR_MARGIN,
  LONG_WINDOW,
  SHORT_WINDOW,
  USAGE_HISTORY_KEY,
  burnRate,
  formatRate,
  isSameEpoch,
  loadUsageHistory,
  parseUsageHistory,
  projectUsage,
  projectWindow,
  projectionSentence,
  projectionTooltip,
  pruneSamples,
  recordUsage,
  saveUsageHistory,
  windowClass,
  worseBand,
  worstProjection,
  type UsageHistory,
  type WindowHistory,
} from "$lib/usageProjection";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_800_000_000_000; // a round epoch ms to anchor every case

function window(over: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: "five_hour",
    label: "5-hour",
    usedPercent: 40,
    resetsAt: Math.floor((T0 + 3 * HOUR) / 1000),
    ...over,
  };
}

function ready(windows: UsageWindow[], observedAtMs: number): AgentUsageReport {
  return {
    state: "ready",
    windows,
    plan: "max",
    observedAt: Math.floor(observedAtMs / 1000),
    cached: false,
  };
}

/// A history whose samples run from `from` to `to` percent over `spanMs`,
/// ending at T0. Written this way because every projection case is really
/// a statement about a rate, and spelling out sample arrays hid that.
function history(from: number, to: number, spanMs: number, resetsAt: number | null): WindowHistory {
  return {
    resetsAt,
    samples: [
      { atMs: T0 - spanMs, usedPercent: from },
      { atMs: T0, usedPercent: to },
    ],
  };
}

describe("window classes", () => {
  it("sorts each route's ids into the cadence the card asked for", () => {
    expect(windowClass("five_hour")).toBe(SHORT_WINDOW);
    expect(windowClass("primary")).toBe(SHORT_WINDOW);
    expect(windowClass("seven_day")).toBe(LONG_WINDOW);
    expect(windowClass("secondary")).toBe(LONG_WINDOW);
    expect(windowClass("spend_limit")).toBe(LONG_WINDOW);
    expect(SHORT_WINDOW.sampleIntervalMs).toBe(5 * MINUTE);
    expect(LONG_WINDOW.sampleIntervalMs).toBe(3 * HOUR);
  });

  // The asymmetry is deliberate: a 3-hour cadence inside a 5-hour window
  // yields at most one sample per epoch, so an unknown short window
  // treated as long would never project at all.
  it("treats an unrecognised window as short", () => {
    expect(windowClass("weekly_opus")).toBe(SHORT_WINDOW);
  });
});

describe("recording samples", () => {
  it("stores the first reading of a window", () => {
    const next = recordUsage({}, "claude-code", ready([window()], T0));
    expect(next["claude-code"].five_hour.samples).toEqual([{ atMs: T0, usedPercent: 40 }]);
  });

  // The poller runs every 3 minutes against a 5-minute cadence, so most
  // readings must store nothing -- and say so by identity, which is what
  // keeps the store and localStorage from being rewritten every poll.
  it("returns the same object when the reading is inside the sampling interval", () => {
    const first = recordUsage({}, "claude-code", ready([window()], T0));
    const again = recordUsage(
      first,
      "claude-code",
      ready([window({ usedPercent: 41 })], T0 + 3 * MINUTE)
    );
    expect(again).toBe(first);
  });

  it("stores a reading once a full interval has passed", () => {
    const first = recordUsage({}, "claude-code", ready([window()], T0));
    const next = recordUsage(
      first,
      "claude-code",
      ready([window({ usedPercent: 45 })], T0 + 6 * MINUTE)
    );
    expect(next["claude-code"].five_hour.samples).toHaveLength(2);
  });

  // A cached report replays the reading it already gave, and the codex
  // route can hand back an event older than one already stored. Storing
  // either would flatten the measured span towards zero.
  it("ignores a reading no newer than the one it holds", () => {
    const first = recordUsage({}, "claude-code", ready([window()], T0));
    expect(recordUsage(first, "claude-code", ready([window()], T0))).toBe(first);
    expect(
      recordUsage(first, "claude-code", ready([window({ usedPercent: 39 })], T0 - HOUR))
    ).toBe(first);
  });

  it("keeps nothing from a probe that could not answer", () => {
    const first = recordUsage({}, "claude-code", ready([window()], T0));
    const failed: AgentUsageReport = { state: "unavailable", reason: "offline", retryAfter: null };
    expect(recordUsage(first, "claude-code", failed)).toBe(first);
  });

  it("drops a window the route stopped reporting", () => {
    const both = recordUsage(
      {},
      "claude-code",
      ready([window(), window({ id: "seven_day", label: "Weekly", usedPercent: 10 })], T0)
    );
    const one = recordUsage(both, "claude-code", ready([window()], T0 + 6 * MINUTE));
    expect(Object.keys(one["claude-code"])).toEqual(["five_hour"]);
  });

  it("keeps profiles apart", () => {
    let h = recordUsage({}, "claude-code", ready([window()], T0));
    h = recordUsage(h, "codex", ready([window({ id: "primary", usedPercent: 5 })], T0));
    expect(h["claude-code"].five_hour.samples[0].usedPercent).toBe(40);
    expect(h.codex.primary.samples[0].usedPercent).toBe(5);
  });
});

describe("epoch breaks", () => {
  const stored: WindowHistory = {
    resetsAt: 1000,
    samples: [{ atMs: T0, usedPercent: 60 }],
  };

  it("continues while the reset instant and the counter both hold", () => {
    expect(
      isSameEpoch(
        stored,
        window({ resetsAt: 1000 }),
        { atMs: T0 + 6 * MINUTE, usedPercent: 61 },
        SHORT_WINDOW
      )
    ).toBe(true);
  });

  it("breaks when the reset instant moves", () => {
    expect(
      isSameEpoch(
        stored,
        window({ resetsAt: 2000 }),
        { atMs: T0 + 6 * MINUTE, usedPercent: 61 },
        SHORT_WINDOW
      )
    ).toBe(false);
  });

  // Inside one epoch the counter only grows, so a real decline is a reset
  // gavin did not witness -- and continuing across it would measure a
  // negative burn and project a window that fills itself back up.
  it("breaks when the counter goes backwards", () => {
    expect(
      isSameEpoch(stored, window({ resetsAt: 1000 }), { atMs: T0 + HOUR, usedPercent: 5 }, SHORT_WINDOW)
    ).toBe(false);
  });

  it("tolerates float noise rather than reading it as a reset", () => {
    expect(
      isSameEpoch(
        stored,
        window({ resetsAt: 1000 }),
        { atMs: T0 + 6 * MINUTE, usedPercent: 59.8 },
        SHORT_WINDOW
      )
    ).toBe(true);
  });

  // Nothing can sit inside one epoch for longer than the epoch lasts, so
  // this is the guard for a route that never says when it resets.
  it("breaks on a gap longer than the window itself", () => {
    expect(
      isSameEpoch(stored, window({ resetsAt: 1000 }), { atMs: T0 + 6 * HOUR, usedPercent: 70 }, SHORT_WINDOW)
    ).toBe(false);
    expect(
      isSameEpoch(stored, window({ resetsAt: 1000 }), { atMs: T0 + 6 * HOUR, usedPercent: 70 }, LONG_WINDOW)
    ).toBe(true);
  });

  it("starts a fresh epoch through recordUsage when the window resets", () => {
    const before = recordUsage({}, "claude-code", ready([window({ usedPercent: 90 })], T0));
    const after = recordUsage(
      before,
      "claude-code",
      ready([window({ usedPercent: 2, resetsAt: 99_999 })], T0 + 6 * MINUTE)
    );
    expect(after["claude-code"].five_hour.samples).toEqual([
      { atMs: T0 + 6 * MINUTE, usedPercent: 2 },
    ]);
  });
});

describe("pruning", () => {
  it("keeps one sample older than the baseline as the rate's anchor", () => {
    const samples = [
      { atMs: T0 - 10 * HOUR, usedPercent: 1 },
      { atMs: T0 - 5 * HOUR, usedPercent: 2 },
      { atMs: T0 - 30 * MINUTE, usedPercent: 8 },
      { atMs: T0, usedPercent: 9 },
    ];
    expect(pruneSamples(samples, HOUR)).toEqual([
      { atMs: T0 - 5 * HOUR, usedPercent: 2 },
      { atMs: T0 - 30 * MINUTE, usedPercent: 8 },
      { atMs: T0, usedPercent: 9 },
    ]);
  });

  // The whole reason the anchor is kept: coming back on Monday, the pair
  // spanning the weekend is the most informative reading the weekly
  // window will ever produce, and dropping it would leave one sample and
  // no rate at all.
  it("survives a weekend with the app closed", () => {
    const friday = { atMs: T0 - 3 * 24 * HOUR, usedPercent: 30 };
    const monday = { atMs: T0, usedPercent: 34 };
    const kept = pruneSamples([friday, monday], LONG_WINDOW.rateBaselineMs);
    expect(kept).toEqual([friday, monday]);
    expect(burnRate({ samples: kept, resetsAt: null }, LONG_WINDOW)?.perHour).toBeCloseTo(
      4 / 72,
      6
    );
  });

  it("bounds what one window keeps", () => {
    let samples: { atMs: number; usedPercent: number }[] = [];
    for (let i = 0; i < 200; i++) {
      samples = pruneSamples(
        [...samples, { atMs: T0 + i * 5 * MINUTE, usedPercent: i * 0.1 }],
        SHORT_WINDOW.rateBaselineMs
      );
    }
    expect(samples.length).toBeLessThanOrEqual(14);
  });
});

describe("the burn rate", () => {
  it("says nothing from a single sample", () => {
    expect(burnRate({ samples: [{ atMs: T0, usedPercent: 10 }], resetsAt: null }, SHORT_WINDOW)).toBeNull();
    expect(burnRate(undefined, SHORT_WINDOW)).toBeNull();
  });

  it("says nothing until a full sampling interval has been spanned", () => {
    expect(burnRate(history(10, 12, 2 * MINUTE, null), SHORT_WINDOW)).toBeNull();
    expect(burnRate(history(10, 12, 5 * MINUTE, null), SHORT_WINDOW)).not.toBeNull();
  });

  it("reads percentage points per hour off the endpoints", () => {
    const rate = burnRate(history(10, 22, 2 * HOUR, null), SHORT_WINDOW);
    expect(rate?.perHour).toBeCloseTo(6, 6);
    expect(rate?.spanMs).toBe(2 * HOUR);
    expect(rate?.samples).toBe(2);
  });

  it("never reports a negative burn", () => {
    expect(burnRate(history(30, 29.9, HOUR, null), SHORT_WINDOW)?.perHour).toBe(0);
  });
});

describe("the projection", () => {
  const resetsIn3h = Math.floor((T0 + 3 * HOUR) / 1000);

  it("is red when the window runs dry before it resets", () => {
    // 40% used, 3h to the reset, 30 points an hour: gone in two.
    const p = projectWindow(
      window({ usedPercent: 40, resetsAt: resetsIn3h }),
      history(10, 40, HOUR, resetsIn3h),
      "claude-code",
      T0
    );
    expect(p.status).toBe("projected");
    expect(p.ratePerHour).toBeCloseTo(30, 6);
    expect(p.exhaustAtMs).toBeCloseTo(T0 + 2 * HOUR, -3);
    expect(p.marginRatio).toBeLessThan(0);
    expect(p.band).toBe("over");
  });

  it("is amber when it lands just past the reset", () => {
    // 40% used, 3h left, 18 points an hour: exhausted at 3h20m, which is
    // 11% of the remaining window as slack -- under the 25% green needs.
    const p = projectWindow(
      window({ usedPercent: 40, resetsAt: resetsIn3h }),
      history(22, 40, HOUR, resetsIn3h),
      "claude-code",
      T0
    );
    expect(p.marginRatio).toBeGreaterThan(0);
    expect(p.marginRatio).toBeLessThan(CLEAR_MARGIN);
    expect(p.band).toBe("tight");
  });

  it("is green when it lands past the reset by the margin", () => {
    const p = projectWindow(
      window({ usedPercent: 40, resetsAt: resetsIn3h }),
      history(35, 40, HOUR, resetsIn3h),
      "claude-code",
      T0
    );
    expect(p.marginRatio).toBeGreaterThan(CLEAR_MARGIN);
    expect(p.band).toBe("clear");
  });

  it("draws nothing while it is still measuring a quiet window", () => {
    const p = projectWindow(window({ usedPercent: 40 }), undefined, "claude-code", T0);
    expect(p.status).toBe("measuring");
    expect(p.band).toBeNull();
  });

  // "Gavin has no idea yet" and "you have room" must never share a
  // colour, but a window already three quarters gone is worth a light
  // whether or not a rate exists.
  it("still speaks while measuring when the level alone is loud", () => {
    expect(
      projectWindow(window({ usedPercent: 80 }), undefined, "claude-code", T0).band
    ).toBe("tight");
    expect(
      projectWindow(window({ usedPercent: 93 }), undefined, "claude-code", T0).band
    ).toBe("over");
  });

  it("calls a flat burn green", () => {
    const p = projectWindow(
      window({ usedPercent: 40, resetsAt: resetsIn3h }),
      history(40, 40, 2 * HOUR, resetsIn3h),
      "claude-code",
      T0
    );
    expect(p.status).toBe("flat");
    expect(p.exhaustAtMs).toBeNull();
    expect(p.band).toBe("clear");
  });

  // The trap this composition exists to close: at 96% with nothing
  // running, the trajectory says "never runs out", which is true and
  // useless -- the next agent started against it hits the wall in
  // minutes, and a green light beside a red bar is the panel
  // contradicting itself.
  it("never shows green over a window that is nearly spent", () => {
    const p = projectWindow(
      window({ usedPercent: 96, resetsAt: resetsIn3h }),
      history(96, 96, 2 * HOUR, resetsIn3h),
      "claude-code",
      T0
    );
    expect(p.status).toBe("flat");
    expect(p.band).toBe("over");
  });

  it("answers a full window without consulting the rate", () => {
    const p = projectWindow(
      window({ usedPercent: 100, resetsAt: resetsIn3h }),
      history(80, 100, HOUR, resetsIn3h),
      "claude-code",
      T0
    );
    expect(p.status).toBe("exhausted");
    expect(p.band).toBe("over");
    expect(projectionSentence(p, T0)).toContain("ceiling");
  });

  // A runway with no finish line to race it against. The rate is real and
  // worth printing; the band cannot come from it.
  it("reports a runway but no verdict when the route gives no reset", () => {
    const p = projectWindow(
      window({ usedPercent: 40, resetsAt: null }),
      history(10, 40, HOUR, null),
      "claude-code",
      T0
    );
    expect(p.status).toBe("no-reset");
    expect(p.exhaustAtMs).toBeCloseTo(T0 + 2 * HOUR, -3);
    expect(p.band).toBeNull();
    expect(projectionSentence(p, T0)).toContain("never says when the window resets");
  });
});

describe("choosing what one semaphore shows", () => {
  it("prefers the worse band, then the tighter margin", () => {
    const base = { profileId: "p", spanMs: HOUR, samples: 2, status: "projected" as const };
    const clear = { ...base, windowId: "a", label: "A", usedPercent: 10, resetsAt: 1, ratePerHour: 1, exhaustAtMs: 1, marginRatio: 2, band: "clear" as const };
    const tightA = { ...clear, windowId: "b", label: "B", marginRatio: 0.2, band: "tight" as const };
    const tightB = { ...clear, windowId: "c", label: "C", marginRatio: 0.05, band: "tight" as const };
    const over = { ...clear, windowId: "d", label: "D", marginRatio: -0.5, band: "over" as const };
    expect(worstProjection([clear, tightA, tightB])?.windowId).toBe("c");
    expect(worstProjection([clear, tightA, over, tightB])?.windowId).toBe("d");
    expect(worstProjection([{ ...clear, band: null }])).toBeNull();
    expect(worstProjection([])).toBeNull();
  });

  it("ranks the bands and treats an absent one as silence", () => {
    expect(worseBand("clear", "over")).toBe("over");
    expect(worseBand("tight", "clear")).toBe("tight");
    expect(worseBand(null, "tight")).toBe("tight");
    expect(worseBand("clear", null)).toBe("clear");
    expect(worseBand(null, null)).toBeNull();
  });

  it("projects only the profiles in use, and only the ones with readings", () => {
    const reports: Record<string, AgentUsageReport> = {
      "claude-code": ready([window(), window({ id: "seven_day", label: "Weekly", usedPercent: 20 })], T0),
      codex: { state: "unsupported" },
    };
    const rows = projectUsage({
      profileIds: ["claude-code", "codex", "gemini"],
      reports,
      history: {},
      nowMs: T0,
    });
    expect(rows.map((r) => r.windowId)).toEqual(["five_hour", "seven_day"]);
    expect(rows.every((r) => r.profileId === "claude-code")).toBe(true);
  });
});

describe("the words", () => {
  it("keeps a decimal only where it decides something", () => {
    expect(formatRate(0)).toBe("0%/h");
    expect(formatRate(2.34)).toBe("2.3%/h");
    expect(formatRate(23.4)).toBe("23%/h");
  });

  it("leads a tooltip with the agent and the window", () => {
    const p = projectWindow(
      window({ usedPercent: 40 }),
      history(10, 40, HOUR, window().resetsAt),
      "claude-code",
      T0
    );
    expect(projectionTooltip(p, "Claude Code", T0)).toMatch(/^Claude Code · 5-hour 40% — /);
  });

  it("names the cadence a window is still waiting on", () => {
    const weekly = projectWindow(
      window({ id: "seven_day", label: "Weekly", usedPercent: 20 }),
      { samples: [{ atMs: T0, usedPercent: 20 }], resetsAt: null },
      "claude-code",
      T0
    );
    expect(projectionSentence(weekly, T0)).toContain("3h");
  });
});

describe("persistence", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it("round-trips a history", () => {
    const storage = fakeStorage();
    const h = recordUsage({}, "claude-code", ready([window()], T0));
    saveUsageHistory(h, storage);
    expect(loadUsageHistory(storage)).toEqual(h);
  });

  it("clears the key rather than storing an empty object", () => {
    const storage = fakeStorage();
    storage.setItem(USAGE_HISTORY_KEY, "{}");
    saveUsageHistory({}, storage);
    expect(storage.map.has(USAGE_HISTORY_KEY)).toBe(false);
  });

  it("remembers nothing when there is no storage at all", () => {
    expect(loadUsageHistory(undefined)).toEqual({});
    expect(() => saveUsageHistory({ a: {} }, undefined)).not.toThrow();
  });

  // Hand-edited or half-written history must read as no history rather
  // than poison a rate: one NaN sample would make every projection off
  // that window NaN, silently.
  it("drops anything it cannot trust", () => {
    expect(parseUsageHistory(null)).toEqual({});
    expect(parseUsageHistory("not json")).toEqual({});
    expect(parseUsageHistory("[]")).toEqual({});
    expect(
      parseUsageHistory(
        JSON.stringify({
          "claude-code": {
            five_hour: {
              resetsAt: "soon",
              samples: [
                { atMs: T0, usedPercent: 10 },
                { atMs: null, usedPercent: 12 },
                { atMs: T0 + HOUR, usedPercent: "x" },
              ],
            },
            seven_day: { samples: [] },
          },
          junk: 4,
        })
      )
    ).toEqual({
      "claude-code": { five_hour: { resetsAt: null, samples: [{ atMs: T0, usedPercent: 10 }] } },
    });
  });

  it("sorts and prunes what it reads back", () => {
    const parsed: UsageHistory = parseUsageHistory(
      JSON.stringify({
        p: {
          five_hour: {
            resetsAt: 5,
            samples: [
              { atMs: T0, usedPercent: 9 },
              { atMs: T0 - 10 * HOUR, usedPercent: 1 },
              { atMs: T0 - 5 * HOUR, usedPercent: 2 },
            ],
          },
        },
      })
    );
    expect(parsed.p.five_hour.samples.map((s) => s.usedPercent)).toEqual([2, 9]);
  });
});
