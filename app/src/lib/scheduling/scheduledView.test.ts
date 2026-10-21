import { describe, expect, it } from "vitest";
import {
  readableFires,
  resolveScheduledSelection,
  scheduledControls,
  scheduledRow,
  scheduledTabNeedsLook,
  sourceCardCandidates,
} from "$lib/scheduling/scheduledView";
import {
  agentVerdict,
  defaultForm,
  formFromRule,
  formRule,
  headlessChoices,
  scheduleCardBlocker,
} from "$lib/scheduling/scheduleDialog";
import type { ScheduledFire, ScheduledTask } from "$lib/scheduling/scheduledTask";

const rule = { at: "2026-10-21T09:00", every: { n: 2, unit: "minutes" as const }, runs: 3 };

function fire(over: Partial<ScheduledFire> = {}): ScheduledFire {
  return {
    id: 1, slot: 0, at: new Date(2026, 9, 21, 9, 0).getTime() / 1000, outcome: "exited", skipReason: null,
    sessionId: "s", exitCode: 0, endedAt: 1, reportPath: "/r.md", headline: "Tests green", hasReport: true, hasRaw: true,
    ...over,
  };
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    path: "/ws/.gavin-root/scheduled/t.md", name: "t", title: "Nightly", agent: null, model: null, effort: null,
    complexity: null, from: "t.md", schedule: "at=2026-10-21T09:00 every=2m runs=3", rule, scheduleError: null,
    paused: false, body: "b", fireCount: 0, lastSlot: null, fires: [], ...over,
  };
}

const now = new Date(2026, 9, 21, 9, 1);

describe("a row", () => {
  it("says the schedule, the next and last run, the result and the count", () => {
    const row = scheduledRow(task({ fireCount: 1, lastSlot: 0, fires: [fire()] }), now);
    expect(row).toMatchObject({
      title: "Nightly",
      schedule: "Every 2 minutes from Oct 21, 09:00 · 3 runs",
      nextRun: "Oct 21, 09:02",
      lastRun: "Oct 21, 09:00",
      lastResult: "Tests green",
      totalRuns: "1 of 3",
      state: "scheduled",
      needsLook: false,
    });
  });

  it("counts an indefinite schedule plainly and says when there is none", () => {
    expect(scheduledRow(task({ rule: { ...rule, runs: null }, fireCount: 7 }), now).totalRuns).toBe("7");
    const bare = scheduledRow(task({ rule: null, schedule: null }), now);
    expect(bare.schedule).toBe("Not scheduled — Run now only");
    expect(bare.nextRun).toBeNull();
  });

  it("marks the tab when a latest run wrote no report", () => {
    expect(scheduledTabNeedsLook([task({ fires: [fire()] })])).toBe(false);
    expect(scheduledTabNeedsLook([task(), task({ fires: [fire({ hasReport: false, headline: null })] })])).toBe(true);
  });
});

describe("the controls", () => {
  it("pause or resume a schedule, and hold Run now while a run is going", () => {
    expect(scheduledControls(task()).pauseLabel).toBe("Pause");
    expect(scheduledControls(task({ paused: true })).pauseLabel).toBe("Resume");
    expect(scheduledControls(task({ rule: null, schedule: null })).pauseLabel).toBeNull();
    expect(scheduledControls(task({ fires: [fire({ outcome: "running" })] })).runNowBlocked).toBe("A run of this task is going");
  });

  it("keep the selection while its row is there", () => {
    const tasks = [task({ path: "/a" }), task({ path: "/b" })];
    expect(resolveScheduledSelection(tasks, "/b")).toBe("/b");
    expect(resolveScheduledSelection(tasks, "/gone")).toBe("/a");
    expect(resolveScheduledSelection([], "/a")).toBeNull();
  });

  it("list the runs that left something to read", () => {
    const t = task({ fires: [fire({ id: 3, outcome: "skipped", hasReport: false, hasRaw: false }), fire({ id: 2 })] });
    expect(readableFires(t).map((f) => f.id)).toEqual([2]);
  });

  it("look for the source card on the board, in done/ and in the archive", () => {
    expect(sourceCardCandidates("t.md")).toEqual([
      ".gavin-root/plans/t.md",
      ".gavin-root/plans/done/t.md",
      ".gavin-root/plans/archive/t.md",
    ]);
    expect(sourceCardCandidates(null)).toEqual([]);
  });
});

describe("the Schedule dialog", () => {
  it("starts as a single shot five minutes out, on the minute", () => {
    expect(defaultForm(new Date(2026, 9, 21, 9, 0, 40))).toMatchObject({ at: "2026-10-21T09:05", repeat: false });
  });

  it("turns its form into a rule, and back", () => {
    expect(formRule(defaultForm(now))).toEqual({ at: "2026-10-21T09:06", every: null, runs: 1 });
    expect(formRule(formFromRule(rule, now))).toEqual(rule);
    const forever = { ...rule, runs: null };
    expect(formRule(formFromRule(forever, now))).toEqual(forever);
  });

  it("refuses a form that makes no schedule", () => {
    expect(formRule({ ...defaultForm(now), at: "" })).toBe("Pick a start date and time");
    expect(typeof formRule({ ...formFromRule(rule, now), n: 0 })).toBe("string");
    expect(typeof formRule({ ...formFromRule(rule, now), runs: 0 })).toBe("string");
  });

  it("offers headless agents when the task's own has no headless mode, and refuses when none has", () => {
    const profiles = [
      { id: "claude-code", label: "Claude Code", headlessArgs: "-p --" },
      { id: "opencode", label: "opencode", headlessArgs: "run --agent gavin-commit --auto --" },
      { id: "custom", label: "Mine", headlessArgs: "" },
    ];
    expect(headlessChoices(profiles)).toEqual([{ id: "claude-code", label: "Claude Code" }]);
    expect(agentVerdict({ profileId: "claude-code", label: "Claude Code", headlessArgs: "-p --" }, profiles)).toEqual({
      kind: "ok",
      label: "Claude Code",
    });
    expect(agentVerdict({ profileId: "custom", label: "Mine", headlessArgs: "" }, profiles)).toEqual({
      kind: "pick",
      choices: [{ id: "claude-code", label: "Claude Code" }],
      why: "Mine has no headless mode a scheduled run can use",
    });
    expect(agentVerdict({ profileId: "custom", headlessArgs: "" }, profiles.slice(1)).kind).toBe("blocked");
  });

  it("schedules task cards only", () => {
    expect(scheduleCardBlocker("task")).toBeNull();
    expect(scheduleCardBlocker("plan")).toBe("plans can't be scheduled yet");
    expect(scheduleCardBlocker("note")).toBe("only task cards can be scheduled");
  });
});
