// Scheduled tasks (ADR 0010), as the Demo Workstation answers them: the
// list a workspace's Scheduled surface reads (`list_scheduled_tasks`), a
// run's report (`scheduled_report`), and the edits a phone makes on the
// desk -- a field written, a task duplicated or deleted.
//
// Nothing here fires a task. The desk's scheduler does that, and a phone
// never asks it to: the claim and the launch record are refused to the
// Remote role before they reach any table.
import type { ScheduledTask } from "$lib/scheduling/scheduledTask";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import { DEMO } from "$companion/demo/sampleData";

/// A run's report and its saved terminal, by fire id.
export type DemoScheduledReports = Record<number, { markdown: string | null; raw: string | null }>;

const DAY = 86_400;

function scheduledPath(root: string, name: string): string {
  return `${root}/.gavin-root/scheduled/${name}.md`;
}

/// atlas-api's two: a nightly audit that has run three times, and a
/// paused weekly sweep whose one run left no report.
export function sampleScheduled(now: number): { tasks: ScheduledTask[]; reports: DemoScheduledReports } {
  const runs = (name: string) => `${DEMO.atlasRoot}/.gavin-root/scheduled/runs/${name}`;
  const nightly: ScheduledTask = {
    path: scheduledPath(DEMO.atlasRoot, "dependency-audit"),
    name: "dependency-audit",
    title: "Nightly dependency audit",
    agent: null,
    model: null,
    effort: null,
    complexity: "simple",
    from: "dependency-audit.md",
    schedule: "at=2026-10-01T02:00 every=1d runs=inf",
    rule: { at: "2026-10-01T02:00", every: { n: 1, unit: "days" }, runs: null },
    scheduleError: null,
    paused: false,
    body: "Run `npm audit` and `cargo audit`. Open a card for anything high or critical.",
    fireCount: 3,
    lastSlot: 20,
    fires: [3, 2, 1].map((i) => ({
      id: i,
      slot: 17 + i,
      at: now - (4 - i) * DAY,
      outcome: "exited" as const,
      skipReason: null,
      sessionId: `s-audit-${i}`,
      exitCode: 0,
      endedAt: now - (4 - i) * DAY + 300,
      reportPath: `${runs("dependency-audit")}/2026102${i}-020000.md`,
      headline: i === 3 ? "One high advisory in jsonwebtoken" : "No advisories",
      hasReport: true,
      hasRaw: true,
    })),
  };
  const weekly: ScheduledTask = {
    path: scheduledPath(DEMO.atlasRoot, "flaky-sweep"),
    name: "flaky-sweep",
    title: "Weekly flaky test sweep",
    agent: "codex",
    model: null,
    effort: null,
    complexity: null,
    from: null,
    schedule: "at=2026-10-05T07:00 every=1w runs=8",
    rule: { at: "2026-10-05T07:00", every: { n: 1, unit: "weeks" }, runs: 8 },
    scheduleError: null,
    paused: true,
    body: "Run the suite five times and list the tests that failed in some runs and not others.",
    fireCount: 1,
    lastSlot: 0,
    fires: [
      {
        id: 4,
        slot: 0,
        at: now - 9 * DAY,
        outcome: "exited",
        skipReason: null,
        sessionId: "s-flaky-1",
        exitCode: 1,
        endedAt: now - 9 * DAY + 900,
        reportPath: `${runs("flaky-sweep")}/20261005-070000.md`,
        headline: null,
        hasReport: false,
        hasRaw: true,
      },
    ],
  };
  const reports: DemoScheduledReports = {
    1: { markdown: "# No advisories\n\nBoth audits were clean.", raw: "found 0 vulnerabilities" },
    2: { markdown: "# No advisories\n\nBoth audits were clean.", raw: "found 0 vulnerabilities" },
    3: {
      markdown:
        "# One high advisory in jsonwebtoken\n\n`npm audit` flags jsonwebtoken < 9.0.3.\n\n" +
        "## Needs the human\n\nFiled `bump-jsonwebtoken.md`; the bump changes the token API.",
      raw: "1 high severity vulnerability",
    },
    4: { markdown: null, raw: "test result: FAILED. 412 passed; 3 failed" },
  };
  return { tasks: [nightly, weekly], reports };
}

function find(demo: DemoContext, path: string): ScheduledTask {
  const task = demo.state.scheduled.find((t) => t.path === path);
  if (!task) throw new DemoFailure(`not a Scheduled task: ${path}`);
  return task;
}

function changed(demo: DemoContext, workspaceId: string): void {
  demo.emit("scheduled-tasks-changed", workspaceId);
}

export const SCHEDULED_COMMANDS: Record<string, DemoCommand> = {
  list_scheduled_tasks: (args, demo): Answer<"listScheduledTasks"> => {
    const root = text(args, "rootPath");
    return demo.state.scheduled.filter((t) => t.path.startsWith(`${root}/`));
  },
  scheduled_report: (args, demo): Answer<"scheduledReport"> => {
    const id = args.fireId;
    if (typeof id !== "number") throw new DemoFailure('missing argument "fireId"');
    return demo.state.scheduledReports[id] ?? { markdown: null, raw: null };
  },
  set_scheduled_task_field: (args, demo): Answer<"setScheduledTaskField"> => {
    const task = find(demo, text(args, "path"));
    const key = text(args, "key");
    const value = text(args, "value");
    switch (key) {
      case "paused":
        task.paused = value === "true";
        break;
      case "schedule":
        // The demo keeps no parser of its own: clearing is the one schedule
        // write a phone makes without the desk's dialog.
        if (value !== "") throw new DemoFailure("the Demo Workstation only unschedules");
        task.schedule = null;
        task.rule = null;
        task.fireCount = 0;
        task.lastSlot = null;
        break;
      case "title":
      case "body":
        task[key] = value;
        break;
      case "agent":
      case "model":
      case "effort":
      case "complexity":
        task[key] = value || null;
        break;
      default:
        throw new DemoFailure(`a Scheduled task has no field ${key}`);
    }
    changed(demo, text(args, "workspaceId"));
  },
  duplicate_scheduled_task: (args, demo): Answer<"duplicateScheduledTask"> => {
    const task = find(demo, text(args, "path"));
    const taken = new Set(demo.state.scheduled.map((t) => t.name));
    let n = 2;
    while (taken.has(`${task.name}-${n}`)) n += 1;
    const name = `${task.name}-${n}`;
    const path = task.path.replace(/[^/]+\.md$/, `${name}.md`);
    demo.state.scheduled.push({ ...task, name, path, fireCount: 0, lastSlot: null, fires: [] });
    changed(demo, text(args, "workspaceId"));
    return path;
  },
  // The desk would launch it; the demo files the run as if it had, with
  // a report, since nothing here runs an agent.
  scheduled_run_now_for_device: (args, demo): Answer<"scheduledRunNowForDevice"> => {
    const task = find(demo, text(args, "path"));
    if (task.fires.some((f) => f.outcome === "running" || f.outcome === "launching")) {
      throw new DemoFailure("a run of this task is already going");
    }
    const id = Math.max(0, ...demo.state.scheduled.flatMap((t) => t.fires.map((f) => f.id))) + 1;
    const at = Math.floor(Date.now() / 1000);
    task.fires.unshift({
      id, slot: null, at, outcome: "exited", skipReason: null, sessionId: null, exitCode: 0, endedAt: at,
      reportPath: null, headline: "Ran on the Demo Workstation", hasReport: true, hasRaw: false,
    });
    demo.state.scheduledReports[id] = {
      markdown: "# Ran on the Demo Workstation\n\nA real Workstation runs the task's agent here.",
      raw: null,
    };
    changed(demo, text(args, "workspaceId"));
    return null;
  },
  delete_scheduled_task: (args, demo): Answer<"deleteScheduledTask"> => {
    const path = text(args, "path");
    find(demo, path);
    demo.state.scheduled = demo.state.scheduled.filter((t) => t.path !== path);
    changed(demo, text(args, "workspaceId"));
  },
};
