// The Scheduled hub tab as data (ADR 0010): its rows, what each control
// may do, and where a task's source card might be. Pure, so the tab's
// `.svelte` stays a template over it.

import {
  describeRule,
  formatWhen,
  lastRun,
  lastRunResult,
  latestRunNeedsLook,
  liveFire,
  nextFireAt,
  scheduledState,
  type ScheduledState,
} from "$lib/scheduling/schedule";
import type { ScheduledFire, ScheduledTask } from "$lib/scheduling/scheduledTask";

export const STATE_LABEL: Record<ScheduledState, string> = {
  running: "running",
  scheduled: "scheduled",
  paused: "paused",
  completed: "completed",
  unscheduled: "unscheduled",
  broken: "schedule unreadable",
};

export interface ScheduledRow {
  path: string;
  title: string;
  /// The schedule in words, or why there is none.
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  /// The latest report's headline, "no report", or what became of the
  /// fire (a skip and its reason).
  lastResult: string | null;
  /// Counted fires, against the schedule's runs when it has a number.
  totalRuns: string;
  state: ScheduledState;
  /// The latest run failed to start or wrote no report.
  needsLook: boolean;
}

export function scheduledRow(task: ScheduledTask, now: Date): ScheduledRow {
  const next = nextFireAt(task, now);
  const last = lastRun(task);
  return {
    path: task.path,
    title: task.title,
    schedule: task.scheduleError
      ? `Unreadable schedule: ${task.scheduleError}`
      : task.rule
        ? describeRule(task.rule, now)
        : "Not scheduled — Run now only",
    nextRun: next ? formatWhen(next, now) : null,
    lastRun: last ? formatWhen(new Date(last.at * 1000), now) : null,
    lastResult: lastRunResult(task),
    totalRuns: task.rule?.runs ? `${task.fireCount} of ${task.rule.runs}` : String(task.fireCount),
    state: scheduledState(task),
    needsLook: latestRunNeedsLook(task),
  };
}

/// The dot on the tab: some task's latest run failed or left no report.
export function scheduledTabNeedsLook(tasks: readonly ScheduledTask[]): boolean {
  return tasks.some(latestRunNeedsLook);
}

/// The selected row's path, kept while the list still holds it, else the
/// first row's.
export function resolveScheduledSelection(tasks: readonly ScheduledTask[], selected: string | null): string | null {
  if (selected && tasks.some((t) => t.path === selected)) return selected;
  return tasks[0]?.path ?? null;
}

/// What the row's controls may do.
export interface ScheduledControls {
  /// "Pause" or "Resume", or null when there is no schedule to pause.
  pauseLabel: "Pause" | "Resume" | null;
  /// Why Run now is unavailable, or null.
  runNowBlocked: string | null;
  canUnschedule: boolean;
}

export function scheduledControls(task: ScheduledTask): ScheduledControls {
  return {
    pauseLabel: task.rule ? (task.paused ? "Resume" : "Pause") : null,
    runNowBlocked: liveFire(task) ? "A run of this task is going" : null,
    canUnschedule: task.schedule !== null,
  };
}

/// The fires that left something to read, newest first: the "earlier
/// reports" list.
export function readableFires(task: ScheduledTask): ScheduledFire[] {
  return task.fires.filter((f) => f.hasReport || f.hasRaw);
}

/// "Run #3 · Oct 21, 09:00", "Run now · …", "Skipped · …".
export function fireLabel(fire: ScheduledFire, ordinal: number | null, now: Date): string {
  const when = formatWhen(new Date(fire.at * 1000), now);
  if (fire.outcome === "skipped") return `Skipped · ${when}`;
  if (fire.slot === null) return `Run now · ${when}`;
  return ordinal === null ? `Run · ${when}` : `Run #${ordinal} · ${when}`;
}

/// Where a task's source card can be, relative to the workspace root:
/// on the board, in `done/`, or archived -- in the order a card moves
/// through them. "Open card" takes the first that exists, and the card
/// reads "gone" only when none does.
export function sourceCardCandidates(from: string | null): string[] {
  if (!from) return [];
  const plans = ".gavin-root/plans";
  return [`${plans}/${from}`, `${plans}/done/${from}`, `${plans}/archive/${from}`];
}
