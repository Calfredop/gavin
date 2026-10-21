import { describe, expect, it } from "vitest";
import {
  completed,
  describeRule,
  dueSlot,
  lastRunResult,
  latestRunNeedsLook,
  latestSlot,
  localStamp,
  nextFireAt,
  reportStamp,
  ruleLine,
  scheduledState,
  slotTime,
} from "$lib/scheduling/schedule";
import type { ScheduledFire, ScheduledTask, ScheduleRule } from "$lib/scheduling/scheduledTask";

const at = (s: string) => new Date(s); // local time, no zone
const every2m: ScheduleRule = { at: "2026-10-21T09:00", every: { n: 2, unit: "minutes" }, runs: 3 };
const once: ScheduleRule = { at: "2026-10-21T09:00", every: null, runs: 1 };
const daily: ScheduleRule = { at: "2026-10-21T09:00", every: { n: 1, unit: "days" }, runs: null };

function grid(rule: ScheduleRule | null, over: Partial<ScheduledTask> = {}) {
  return { rule, paused: false, fireCount: 0, lastSlot: null, ...over };
}

function fire(over: Partial<ScheduledFire> = {}): ScheduledFire {
  return {
    id: 1,
    slot: 0,
    at: 0,
    outcome: "exited",
    skipReason: null,
    sessionId: "s-1",
    exitCode: 0,
    endedAt: 1,
    reportPath: "/r.md",
    headline: null,
    hasReport: false,
    hasRaw: true,
    ...over,
  };
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    path: "/ws/.gavin-root/scheduled/t.md",
    name: "t",
    title: "T",
    agent: null,
    model: null,
    effort: null,
    complexity: null,
    from: "t.md",
    schedule: ruleLine(every2m),
    rule: every2m,
    scheduleError: null,
    paused: false,
    body: "b",
    fireCount: 0,
    lastSlot: null,
    fires: [],
    ...over,
  };
}

describe("the grid", () => {
  it("is a fixed grid from the start, never a countdown from the last run", () => {
    expect(slotTime(every2m, 0)).toEqual(at("2026-10-21T09:00"));
    expect(slotTime(every2m, 3)).toEqual(at("2026-10-21T09:06"));
    expect(latestSlot(every2m, at("2026-10-21T08:59"))).toBeNull();
    expect(latestSlot(every2m, at("2026-10-21T09:00"))).toBe(0);
    expect(latestSlot(every2m, at("2026-10-21T09:05:59"))).toBe(2);
  });

  it("steps days on the calendar, so a daily run keeps its wall-clock time", () => {
    for (let k = 0; k < 400; k += 37) {
      const t = slotTime(daily, k)!;
      expect([t.getHours(), t.getMinutes()]).toEqual([9, 0]);
    }
    const t = slotTime(daily, 10)!;
    expect(latestSlot(daily, t)).toBe(10);
    expect(latestSlot(daily, new Date(t.getTime() - 1))).toBe(9);
  });

  it("steps weeks seven days at a time", () => {
    const weekly: ScheduleRule = { at: "2026-10-21T09:00", every: { n: 2, unit: "weeks" }, runs: null };
    expect(slotTime(weekly, 1)).toEqual(at("2026-11-04T09:00"));
  });
});

describe("dueSlot", () => {
  it("fires a single shot once, at or after its start", () => {
    expect(dueSlot(grid(once), at("2026-10-21T08:59"))).toBeNull();
    expect(dueSlot(grid(once), at("2026-10-21T09:00"))).toBe(0);
    expect(dueSlot(grid(once), at("2026-10-23T12:00"))).toBe(0);
    expect(dueSlot(grid(once, { fireCount: 1, lastSlot: 0 }), at("2026-10-23T12:00"))).toBeNull();
  });

  it("collapses the fires missed while the app was closed into one, the latest", () => {
    // Slots 0-4 all passed while closed: only 4 is claimed.
    expect(dueSlot(grid(every2m), at("2026-10-21T09:09"))).toBe(4);
    // Once 4 is claimed, nothing more until slot 5.
    expect(dueSlot(grid(every2m, { fireCount: 1, lastSlot: 4 }), at("2026-10-21T09:09"))).toBeNull();
    expect(dueSlot(grid(every2m, { fireCount: 1, lastSlot: 4 }), at("2026-10-21T09:10"))).toBe(5);
  });

  it("stops after n fires, launched or skipped", () => {
    expect(completed(every2m, 3)).toBe(true);
    expect(dueSlot(grid(every2m, { fireCount: 3, lastSlot: 2 }), at("2026-10-21T10:00"))).toBeNull();
  });

  it("runs on indefinitely", () => {
    expect(dueSlot(grid(daily, { fireCount: 5000, lastSlot: 4999 }), slotTime(daily, 5000)!)).toBe(5000);
  });

  it("never fires a paused or unscheduled task", () => {
    expect(dueSlot(grid(every2m, { paused: true }), at("2026-10-21T09:00"))).toBeNull();
    expect(dueSlot(grid(null), at("2026-10-21T09:00"))).toBeNull();
  });

  it("is not moved by Run now, which claims no slot", () => {
    // A Run now leaves fireCount and lastSlot alone -- the daemon's half --
    // so the grid answers exactly as before it.
    const t = grid(every2m, { fireCount: 1, lastSlot: 0 });
    expect(dueSlot(t, at("2026-10-21T09:02"))).toBe(1);
  });
});

describe("nextFireAt", () => {
  it("is the next slot on the grid, or an overdue one's own time", () => {
    expect(nextFireAt(grid(every2m), at("2026-10-21T08:00"))).toEqual(at("2026-10-21T09:00"));
    expect(nextFireAt(grid(every2m, { fireCount: 1, lastSlot: 0 }), at("2026-10-21T09:00:30"))).toEqual(
      at("2026-10-21T09:02")
    );
    expect(nextFireAt(grid(every2m), at("2026-10-21T09:03"))).toEqual(at("2026-10-21T09:02"));
  });

  it("is nothing once paused, completed or a spent single shot", () => {
    expect(nextFireAt(grid(every2m, { paused: true }), at("2026-10-21T08:00"))).toBeNull();
    expect(nextFireAt(grid(every2m, { fireCount: 3, lastSlot: 2 }), at("2026-10-21T08:00"))).toBeNull();
    expect(nextFireAt(grid(once, { fireCount: 1, lastSlot: 0 }), at("2026-10-21T08:00"))).toBeNull();
  });
});

describe("the row", () => {
  it("names its state, a run going first", () => {
    expect(scheduledState(task())).toBe("scheduled");
    expect(scheduledState(task({ paused: true }))).toBe("paused");
    expect(scheduledState(task({ fireCount: 3 }))).toBe("completed");
    expect(scheduledState(task({ rule: null, schedule: null }))).toBe("unscheduled");
    expect(scheduledState(task({ rule: null, scheduleError: "bad" }))).toBe("broken");
    expect(scheduledState(task({ paused: true, fires: [fire({ outcome: "running" })] }))).toBe("running");
  });

  it("reads the last run's result off its report, or says why there is none", () => {
    expect(lastRunResult(task())).toBeNull();
    expect(lastRunResult(task({ fires: [fire({ headline: "Tests green", hasReport: true })] }))).toBe("Tests green");
    expect(lastRunResult(task({ fires: [fire()] }))).toBe("no report");
    expect(lastRunResult(task({ fires: [fire({ outcome: "skipped", skipReason: "the previous run was still going" })] }))).toBe(
      "Skipped: the previous run was still going"
    );
    expect(lastRunResult(task({ fires: [fire({ outcome: "running" })] }))).toBe("Running…");
  });

  it("wants a look when the latest run failed or wrote no report", () => {
    expect(latestRunNeedsLook(task())).toBe(false);
    expect(latestRunNeedsLook(task({ fires: [fire()] }))).toBe(true);
    expect(latestRunNeedsLook(task({ fires: [fire({ outcome: "failed" })] }))).toBe(true);
    expect(latestRunNeedsLook(task({ fires: [fire({ hasReport: true })] }))).toBe(false);
    expect(latestRunNeedsLook(task({ fires: [fire({ outcome: "skipped" })] }))).toBe(false);
  });
});

describe("words and stamps", () => {
  const now = at("2026-10-21T08:00");
  it("describes a rule", () => {
    expect(describeRule(once, now)).toBe("Once, Oct 21, 09:00");
    expect(describeRule(every2m, now)).toBe("Every 2 minutes from Oct 21, 09:00 · 3 runs");
    expect(describeRule(daily, now)).toBe("Every day from Oct 21, 09:00 · indefinitely");
    expect(describeRule({ ...daily, at: "2027-01-02T09:00" }, now)).toBe("Every day from Jan 2 2027, 09:00 · indefinitely");
  });

  it("writes the line the daemon writes", () => {
    expect(ruleLine(once)).toBe("at=2026-10-21T09:00");
    expect(ruleLine(every2m)).toBe("at=2026-10-21T09:00 every=2m runs=3");
    expect(ruleLine(daily)).toBe("at=2026-10-21T09:00 every=1d runs=inf");
  });

  it("stamps reports and inputs in local time", () => {
    expect(reportStamp(at("2026-10-21T09:05:07"))).toBe("20261021-090507");
    expect(localStamp(at("2026-10-21T09:05:07"))).toBe("2026-10-21T09:05");
  });
});
