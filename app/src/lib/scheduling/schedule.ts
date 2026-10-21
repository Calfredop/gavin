// When a Scheduled task fires (ADR 0010). Pure: every function takes the
// clock as an argument.
//
// A schedule is a fixed grid in this machine's local time: slot k falls
// at start + k·interval, never "interval after the last run" -- a run
// that took ten minutes does not push the next one ten minutes later,
// and a laptop that slept does not slide the whole schedule. Minutes and
// hours step in real time; days and weeks step on the calendar, so a
// daily 09:00 stays at 09:00 across a daylight-saving change.
//
// Fires missed while the app was closed collapse into ONE: the due slot
// is always the LATEST one at or before now, and every slot behind it is
// simply never claimed. The count is of fires, not slots, so a schedule
// of five runs still runs five times however many slots it slept through.

import type { FireOutcome, ScheduledFire, ScheduledTask, ScheduleRule } from "$lib/scheduling/scheduledTask";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Grid = Pick<ScheduledTask, "rule" | "paused" | "fireCount" | "lastSlot">;

/// The rule's start as a local Date, or null when `at` is not
/// `YYYY-MM-DDTHH:MM`.
export function startOf(rule: Pick<ScheduleRule, "at">): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(rule.at);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/// When slot `k` falls.
export function slotTime(rule: ScheduleRule, k: number): Date | null {
  const start = startOf(rule);
  if (!start) return null;
  const every = rule.every;
  if (!every || k === 0) return start;
  switch (every.unit) {
    case "minutes":
      return new Date(start.getTime() + k * every.n * MINUTE_MS);
    case "hours":
      return new Date(start.getTime() + k * every.n * HOUR_MS);
    case "days":
    case "weeks": {
      const days = k * every.n * (every.unit === "weeks" ? 7 : 1);
      const d = new Date(start);
      d.setDate(d.getDate() + days);
      return d;
    }
  }
}

/// The latest slot at or before `now`, or null before the start.
export function latestSlot(rule: ScheduleRule, now: Date): number | null {
  const start = startOf(rule);
  if (!start || now.getTime() < start.getTime()) return null;
  const every = rule.every;
  if (!every) return 0;
  const step =
    every.unit === "minutes"
      ? every.n * MINUTE_MS
      : every.unit === "hours"
        ? every.n * HOUR_MS
        : every.n * DAY_MS * (every.unit === "weeks" ? 7 : 1);
  let k = Math.floor((now.getTime() - start.getTime()) / step);
  // Calendar steps drift from the estimate by a daylight-saving hour.
  const at = (i: number) => slotTime(rule, i)!.getTime();
  while (at(k + 1) <= now.getTime()) k += 1;
  while (k > 0 && at(k) > now.getTime()) k -= 1;
  return k;
}

/// Whether `fireCount` fires have used the schedule up.
export function completed(rule: ScheduleRule, fireCount: number): boolean {
  return rule.runs !== null && fireCount >= rule.runs;
}

/// The slot to claim now, or null when nothing is due: the latest slot
/// at or before `now` that is past the last one claimed -- one fire for
/// every slot missed while the app was closed.
export function dueSlot(task: Grid, now: Date): number | null {
  const rule = task.rule;
  if (!rule || task.paused || completed(rule, task.fireCount)) return null;
  const k = latestSlot(rule, now);
  if (k === null) return null;
  if (task.lastSlot !== null && k <= task.lastSlot) return null;
  return k;
}

/// When the next fire is: an overdue slot's own time (it fires on the
/// scheduler's next pass), else the first slot after `now` and after the
/// last one claimed. Null when nothing more will fire on its own --
/// unscheduled, paused or completed.
export function nextFireAt(task: Grid, now: Date): Date | null {
  const rule = task.rule;
  if (!rule || task.paused || completed(rule, task.fireCount)) return null;
  const due = dueSlot(task, now);
  if (due !== null) return slotTime(rule, due);
  const latest = latestSlot(rule, now);
  let next = latest === null ? 0 : latest + 1;
  if (task.lastSlot !== null) next = Math.max(next, task.lastSlot + 1);
  if (!rule.every && next > 0) return null;
  return slotTime(rule, next);
}

export type ScheduledState = "running" | "scheduled" | "paused" | "completed" | "unscheduled" | "broken";

const LIVE: FireOutcome[] = ["launching", "running"];

/// The fire still going, if one is.
export function liveFire(task: Pick<ScheduledTask, "fires">): ScheduledFire | null {
  return task.fires.find((f) => LIVE.includes(f.outcome)) ?? null;
}

/// What the row says the task is doing. A run going wins over
/// everything; a schedule that cannot be read is `broken`.
export function scheduledState(task: ScheduledTask): ScheduledState {
  if (liveFire(task)) return "running";
  if (task.scheduleError) return "broken";
  if (!task.rule) return "unscheduled";
  if (completed(task.rule, task.fireCount)) return "completed";
  if (task.paused) return "paused";
  return "scheduled";
}

/// The "Last run result" cell: the report's headline, else what became
/// of the fire. Null for a task that has never fired.
export function lastRunResult(task: Pick<ScheduledTask, "fires">): string | null {
  const fire = task.fires[0];
  if (!fire) return null;
  switch (fire.outcome) {
    case "launching":
    case "running":
      return "Running…";
    case "skipped":
      return `Skipped: ${fire.skipReason ?? "no reason recorded"}`;
    case "failed":
      return `Failed to start: ${fire.skipReason ?? "no reason recorded"}`;
    case "exited":
    case "abandoned":
      return fire.headline ?? "no report";
  }
}

/// Whether the latest run wants a look: it failed to start, or ended
/// with no report. What puts the dot on the Scheduled tab.
export function latestRunNeedsLook(task: Pick<ScheduledTask, "fires">): boolean {
  const fire = task.fires[0];
  if (!fire) return false;
  if (fire.outcome === "failed") return true;
  return (fire.outcome === "exited" || fire.outcome === "abandoned") && !fire.hasReport;
}

/// The last fire that actually ran, for "Last run".
export function lastRun(task: Pick<ScheduledTask, "fires">): ScheduledFire | null {
  return task.fires.find((f) => f.outcome !== "skipped") ?? null;
}

/// `YYYYMMDD-HHMMSS` in local time: a Run report's file name.
export function reportStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/// `YYYY-MM-DDTHH:MM` in local time: the value a `datetime-local` input
/// takes, and a rule's `at`.
export function localStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}`
  );
}

/// The `schedule:` line for a rule -- what the daemon's
/// `ScheduleRule::to_line` writes, so a line round-trips unchanged.
export function ruleLine(rule: ScheduleRule): string {
  let line = `at=${rule.at}`;
  if (rule.every) {
    const unit = { minutes: "m", hours: "h", days: "d", weeks: "w" }[rule.every.unit];
    line += ` every=${rule.every.n}${unit} runs=${rule.runs ?? "inf"}`;
  }
  return line;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Oct 21, 09:00", with the year when it is not this one.
export function formatWhen(date: Date, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${p(date.getHours())}:${p(date.getMinutes())}`;
}

const UNIT_WORDS = { minutes: "minute", hours: "hour", days: "day", weeks: "week" } as const;

/// The schedule in words: "Once, Oct 21, 09:00", "Every 2 hours from
/// Oct 21, 09:00 · 5 runs", "Every day from … · indefinitely".
export function describeRule(rule: ScheduleRule, now: Date): string {
  const start = startOf(rule);
  const when = start ? formatWhen(start, now) : rule.at;
  if (!rule.every) return `Once, ${when}`;
  const { n, unit } = rule.every;
  const every = n === 1 ? `Every ${UNIT_WORDS[unit]}` : `Every ${n} ${unit}`;
  const runs = rule.runs === null ? "indefinitely" : rule.runs === 1 ? "1 run" : `${rule.runs} runs`;
  return `${every} from ${when} · ${runs}`;
}
