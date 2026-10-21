import { describe, it, expect } from "vitest";
import {
  ACTIVITY_KINDS,
  YEAR_WEEKS,
  badgeOutcome,
  breadcrumb,
  buildEvents,
  cardTitles,
  cellTip,
  cellValue,
  dayHours,
  dayKey,
  dayLabel,
  eventsIn,
  focusAt,
  hourKey,
  indexEvents,
  kindSummary,
  levelScale,
  loadWindow,
  monthGrid,
  periodBounds,
  pushRange,
  runDuration,
  runTitle,
  step,
  toggleKind,
  weekdayLabels,
  yearGrid,
  yearStart,
  zoomInto,
  zoomOutTo,
  type ActivityCommit,
  type ActivityRun,
  type WorkspaceActivity,
} from "$lib/activity/activity";

/// Local wall-clock time to the wire's seconds, so every test reads the
/// same in any time zone the suite runs in.
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return Math.floor(new Date(y, m, d, h, min).getTime() / 1000);
}

function run(startedAt: number, over: Partial<ActivityRun> = {}): ActivityRun {
  return {
    kind: "card",
    workspaceId: "ws-1",
    path: "/r/.gavin-root/plans/a.md",
    toolId: null,
    sessionId: `s-${startedAt}`,
    command: "claude",
    startedAt,
    endedAt: startedAt + 600,
    exitCode: 0,
    outcome: "exited",
    ...over,
  };
}

function commit(sha: string, when: number, files: string[] = []): ActivityCommit {
  return { sha, at: when, author: "A", subject: `subject ${sha}`, files };
}

function source(id: string, over: Partial<WorkspaceActivity> = {}): WorkspaceActivity {
  return { workspaceId: id, workspaceName: id.toUpperCase(), runs: [], git: { commits: [], pushes: [] }, ...over };
}

// 2026-10-21, a Wednesday, 14:30 local.
const NOW = new Date(2026, 9, 21, 14, 30).getTime();

describe("buildEvents", () => {
  it("merges every workspace's runs, commits and pushes oldest first", () => {
    const events = buildEvents([
      source("a", {
        runs: [run(at(2026, 9, 20, 9))],
        git: { commits: [commit("c1", at(2026, 9, 19))], pushes: [{ at: at(2026, 9, 21), remoteRef: "origin/main", oldSha: null, newSha: "c1" }] },
      }),
      source("b", { runs: [run(at(2026, 9, 18), { workspaceId: "b" })] }),
    ]);
    expect(events.map((e) => [e.type, e.workspaceId])).toEqual([
      ["run", "b"],
      ["commit", "a"],
      ["run", "a"],
      ["push", "a"],
    ]);
  });

  it("counts one commit and one push once across two workspaces on one repository", () => {
    const push = { at: at(2026, 9, 21), remoteRef: "origin/main", oldSha: "x", newSha: "y" };
    const shared = { commits: [commit("same", at(2026, 9, 20))], pushes: [push] };
    const events = buildEvents([source("checkout", { git: shared }), source("worktree", { git: shared })]);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.workspaceId === "checkout")).toBe(true);
  });

  it("draws nothing for a read that did not happen", () => {
    expect(buildEvents([source("x", { runs: null, git: null })])).toEqual([]);
  });
});

describe("indexEvents and cellValue", () => {
  const index = indexEvents(
    buildEvents([
      source("a", {
        runs: [run(at(2026, 9, 20, 9)), run(at(2026, 9, 20, 9, 40))],
        git: {
          commits: [commit("c1", at(2026, 9, 20, 10), ["x.ts", "y.ts"]), commit("c2", at(2026, 9, 20, 23), ["x.ts"])],
          pushes: [{ at: at(2026, 9, 20, 23, 30), remoteRef: "origin/main", oldSha: "c0", newSha: "c2" }],
        },
      }),
      source("b", { git: { commits: [commit("c3", at(2026, 9, 20, 11), ["x.ts"])], pushes: [] } }),
    ])
  );
  const day = index.days.get(dayKey(2026, 9, 20));

  it("buckets by local day and local hour", () => {
    expect(day?.runs).toBe(2);
    expect(day?.commits).toBe(3);
    expect(day?.pushes).toBe(1);
    expect(index.hours.get(hourKey(2026, 9, 20, 9))?.runs).toBe(2);
    expect(index.hours.get(hourKey(2026, 9, 20, 23))?.commits).toBe(1);
    expect(index.days.get(dayKey(2026, 9, 21))).toBeUndefined();
  });

  it("counts distinct files per bucket, one path in two workspaces being two files", () => {
    expect(day?.files.size).toBe(3);
    expect(day?.byWorkspace.get("a")?.files.size).toBe(2);
  });

  it("sums only the kinds picked", () => {
    expect(cellValue(day, ACTIVITY_KINDS)).toBe(2 + 3 + 1 + 3);
    expect(cellValue(day, ["runs"])).toBe(2);
    expect(cellValue(day, ["files", "pushes"])).toBe(4);
    expect(cellValue(undefined, ACTIVITY_KINDS)).toBe(0);
  });

  it("breaks a cell's tooltip down by kind, and by workspace at app level", () => {
    const names = new Map([
      ["a", "Alpha"],
      ["b", "Beta"],
    ]);
    expect(cellTip("Tue 20 Oct 2026", day, ["runs", "pushes"], null)).toBe("Tue 20 Oct 2026\n2 runs · 1 push");
    expect(cellTip("d", day, ["commits"], names)).toBe("d\n3 commits\nAlpha: 2 commits\nBeta: 1 commit");
    expect(cellTip("d", undefined, ACTIVITY_KINDS, names)).toBe("d\nNo activity");
    expect(cellTip("d", day, ["runs"], names)).toBe("d\n2 runs\nAlpha: 2 runs");
  });
});

describe("levelScale", () => {
  it("is 0 for an empty cell and 1..4 by quartile of the busy ones", () => {
    const level = levelScale([0, 1, 2, 3, 4, 5, 6, 7, 8, 0]);
    expect(level(0)).toBe(0);
    // Busy values 1..8: the quartiles fall at 2, 4 and 6.
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(level)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("puts a lone busy day apart from a quiet one", () => {
    const level = levelScale([1, 1, 1, 40]);
    expect(level(1)).toBe(1);
    expect(level(40)).toBe(4);
  });

  it("draws nothing at all for a view with no activity", () => {
    expect(levelScale([0, 0])(5)).toBe(0);
  });
});

describe("the kind picker", () => {
  it("toggles in a fixed order and never turns the last kind off", () => {
    expect(toggleKind(ACTIVITY_KINDS, "commits")).toEqual(["runs", "pushes", "files"]);
    expect(toggleKind(["files", "runs"], "commits")).toEqual(["runs", "commits", "files"]);
    expect(toggleKind(["pushes"], "pushes")).toEqual(["pushes"]);
  });

  it("says All activity with everything on, else names the kinds", () => {
    expect(kindSummary(ACTIVITY_KINDS)).toBe("All activity");
    expect(kindSummary(["commits", "runs"])).toBe("Runs · Commits");
  });
});

describe("yearGrid", () => {
  const grid = yearGrid(NOW);

  it("is 53 Monday-first weeks with today in the last column", () => {
    expect(grid.cells).toHaveLength(YEAR_WEEKS * 7);
    expect(weekdayLabels()[0]).toBe("Mon");
    const today = grid.cells.find((c) => c.key === dayKey(2026, 9, 21));
    expect(today?.col).toBe(YEAR_WEEKS - 1);
    expect(today?.row).toBe(2); // Wednesday
    expect(grid.cells[0].row).toBe(0);
    expect(new Date(grid.cells[0].year, grid.cells[0].month, grid.cells[0].day).getDay()).toBe(1);
  });

  it("marks the rest of this week as future and nothing before it", () => {
    const future = grid.cells.filter((c) => c.future);
    expect(future.map((c) => c.day)).toEqual([22, 23, 24, 25]);
  });

  it("is consecutive local days however the clocks change", () => {
    for (let i = 1; i < grid.cells.length; i++) {
      const a = grid.cells[i - 1];
      const b = grid.cells[i];
      expect(new Date(a.year, a.month, a.day + 1).getTime()).toBe(new Date(b.year, b.month, b.day).getTime());
    }
  });

  it("labels each month once, at the week its first days start", () => {
    const labels = grid.months.map((m) => m.label);
    expect(new Set(labels.map((l, i) => `${l}${grid.months[i].year}`)).size).toBe(labels.length);
    expect(labels.at(-1)).toBe("Oct");
    for (let i = 1; i < grid.months.length; i++) expect(grid.months[i].col - grid.months[i - 1].col).toBeGreaterThanOrEqual(3);
  });

  it("starts where the load window starts", () => {
    const { since, until } = loadWindow(NOW);
    expect(since * 1000).toBe(yearStart(NOW).getTime());
    expect(until * 1000).toBe(new Date(2026, 9, 22).getTime());
  });
});

describe("monthGrid and dayHours", () => {
  it("lands the 1st under its weekday", () => {
    // 1 Oct 2026 is a Thursday: three blanks in a Monday-first week.
    const g = monthGrid(2026, 9, NOW);
    expect(g.lead).toBe(3);
    expect(g.days).toHaveLength(31);
    expect(g.days.filter((d) => d.future).map((d) => d.day)).toEqual(Array.from({ length: 10 }, (_, i) => 22 + i));
    expect(monthGrid(2026, 1, NOW).days).toHaveLength(28);
  });

  it("is 24 hours, the ones after now in the future", () => {
    const hours = dayHours(2026, 9, 21, NOW);
    expect(hours).toHaveLength(24);
    expect(hours.filter((h) => h.future).map((h) => h.hour)[0]).toBe(15);
    expect(dayHours(2026, 9, 20, NOW).some((h) => h.future)).toBe(false);
  });
});

describe("navigation", () => {
  it("zooms in from a cell and back out through the breadcrumb", () => {
    const year = focusAt("year", NOW);
    expect(breadcrumb(year)).toEqual([{ label: "Last 12 months", zoom: "year", current: true }]);
    const day = zoomInto(year, { zoom: "day", year: 2026, month: 9, day: 21 });
    const hour = zoomInto(day, { zoom: "hour", hour: 14 });
    expect(breadcrumb(hour).map((c) => c.label)).toEqual(["2026", "Oct", "21", "14:00"]);
    expect(breadcrumb(hour).at(-1)?.current).toBe(true);
    const month = zoomOutTo(hour, "month");
    expect(month).toMatchObject({ zoom: "month", year: 2026, month: 9, day: 21 });
    expect(zoomInto(month, { zoom: "day", day: 3 })).toMatchObject({ zoom: "day", month: 9, day: 3 });
  });

  it("steps across months, days and hours at the same level", () => {
    const jan31 = { zoom: "month" as const, year: 2026, month: 0, day: 31, hour: 9 };
    expect(step(jan31, 1, NOW)).toMatchObject({ zoom: "month", year: 2026, month: 1, day: 28 });
    expect(step({ ...jan31, zoom: "day" }, 1, NOW)).toMatchObject({ month: 1, day: 1 });
    expect(step({ zoom: "hour", year: 2026, month: 9, day: 20, hour: 23 }, 1, NOW)).toMatchObject({ day: 21, hour: 0 });
    expect(step({ ...jan31, zoom: "month", month: 0 }, -1, NOW)).toMatchObject({ year: 2025, month: 11 });
  });

  it("never steps out of what was loaded, nor into the future, nor at the Year view", () => {
    expect(step(focusAt("year", NOW), 1, NOW)).toBeNull();
    expect(step(focusAt("month", NOW), 1, NOW)).toBeNull();
    expect(step(focusAt("day", NOW), 1, NOW)).toBeNull();
    expect(step(focusAt("hour", NOW), 1, NOW)).toBeNull();
    const first = yearStart(NOW);
    const firstDay = { zoom: "day" as const, year: first.getFullYear(), month: first.getMonth(), day: first.getDate(), hour: 0 };
    expect(step(firstDay, -1, NOW)).toBeNull();
    expect(step(firstDay, 1, NOW)).not.toBeNull();
  });

  it("bounds each period in local time", () => {
    const f = { zoom: "hour" as const, year: 2026, month: 9, day: 21, hour: 14 };
    expect(periodBounds(f, NOW)).toEqual({
      start: new Date(2026, 9, 21, 14).getTime(),
      end: new Date(2026, 9, 21, 15).getTime(),
    });
    expect(periodBounds({ ...f, zoom: "month" }, NOW).end).toBe(new Date(2026, 10, 1).getTime());
  });

  it("names a day the way a tooltip does", () => {
    expect(dayLabel(2026, 9, 21)).toBe("Wed 21 Oct 2026");
  });
});

describe("the leaf list", () => {
  const events = buildEvents([
    source("a", {
      runs: [run(at(2026, 9, 21, 13, 59)), run(at(2026, 9, 21, 14, 5)), run(at(2026, 9, 21, 15, 0))],
      git: {
        commits: [commit("c", at(2026, 9, 21, 14, 10), ["f"])],
        pushes: [{ at: at(2026, 9, 21, 14, 20), remoteRef: "origin/main", oldSha: null, newSha: "c" }],
      },
    }),
  ]);
  const hour = periodBounds({ zoom: "hour", year: 2026, month: 9, day: 21, hour: 14 }, NOW);

  it("is the hour's events in time order, its end not included", () => {
    expect(eventsIn(events, hour.start, hour.end, ACTIVITY_KINDS).map((e) => e.type)).toEqual(["run", "commit", "push"]);
  });

  it("lists a commit for Files as well as for Commits, and drops kinds not picked", () => {
    expect(eventsIn(events, hour.start, hour.end, ["files"]).map((e) => e.type)).toEqual(["commit"]);
    expect(eventsIn(events, hour.start, hour.end, ["pushes", "runs"]).map((e) => e.type)).toEqual(["run", "push"]);
  });
});

describe("rows", () => {
  it("titles a card run from its board, else from its file, and a tool run by name", () => {
    const titles = cardTitles([{ plans: [{ path: "/r/.gavin-root/plans/a.md", title: "Fix login" }] }]);
    expect(runTitle(run(1), titles)).toBe("Fix login");
    expect(runTitle(run(1, { path: "/r/.gavin-root/plans/archive/old-card.md" }), titles)).toBe("old-card.md");
    const tool = run(1, { kind: "tool", path: null, toolId: "builtin:push" });
    expect(runTitle(tool, titles, "Push")).toBe("Push");
    expect(runTitle(tool, titles, null)).toBe("builtin:push");
  });

  it("reads a tool's verdict as the run badge's words", () => {
    expect(badgeOutcome(run(1, { kind: "tool", outcome: "passed", exitCode: 0 }))).toEqual({ outcome: "exited", exitCode: 0 });
    expect(badgeOutcome(run(1, { kind: "tool", outcome: "failed", exitCode: 2 }))).toEqual({ outcome: "failed", exitCode: 2 });
    expect(badgeOutcome(run(1, { outcome: "exited", exitCode: 1 }))).toEqual({ outcome: "exited", exitCode: 1 });
  });

  it("says how long a run took, and nothing for one whose end nobody saw", () => {
    expect(runDuration(run(0, { endedAt: 45 }), 0)).toBe("45s");
    expect(runDuration(run(0, { endedAt: 3 * 3600 + 20 * 60 }), 0)).toBe("3h 20m");
    expect(runDuration(run(0, { endedAt: null, outcome: "running" }), 600)).toBe("10m");
    expect(runDuration(run(0, { endedAt: null, outcome: "abandoned" }), 600)).toBeNull();
  });

  it("names a push's range, from nothing for the push that made the ref", () => {
    expect(pushRange({ at: 0, remoteRef: "origin/main", oldSha: "aaaaaaaaaa", newSha: "bbbbbbbbbb" })).toBe("aaaaaaa → bbbbbbb");
    expect(pushRange({ at: 0, remoteRef: "origin/main", oldSha: null, newSha: "bbbbbbbbbb" })).toBe("new → bbbbbbb");
  });
});
