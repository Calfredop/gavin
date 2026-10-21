// The Schedule dialog as data: its form, the rule the form makes, and
// which agent will run the task. Pure.

import { localStamp, startOf } from "$lib/scheduling/schedule";
import { scheduledRunArgs } from "$lib/scheduling/scheduledRun";
import type { IntervalUnit, ScheduleRule } from "$lib/scheduling/scheduledTask";

export interface ScheduleForm {
  /// `YYYY-MM-DDTHH:MM`, local: a `datetime-local` input's value.
  at: string;
  repeat: boolean;
  n: number;
  unit: IntervalUnit;
  /// Only read when repeating.
  runsMode: "count" | "indefinite";
  runs: number;
}

export const UNIT_OPTIONS: { unit: IntervalUnit; label: string }[] = [
  { unit: "minutes", label: "minutes" },
  { unit: "hours", label: "hours" },
  { unit: "days", label: "days" },
  { unit: "weeks", label: "weeks" },
];

/// A new schedule: once, five minutes from now on the minute.
export function defaultForm(now: Date): ScheduleForm {
  const at = new Date(now.getTime() + 5 * 60_000);
  at.setSeconds(0, 0);
  return { at: localStamp(at), repeat: false, n: 1, unit: "days", runsMode: "indefinite", runs: 3 };
}

/// The form for an existing rule, or the default for none.
export function formFromRule(rule: ScheduleRule | null, now: Date): ScheduleForm {
  if (!rule) return defaultForm(now);
  return {
    at: rule.at,
    repeat: rule.every !== null,
    n: rule.every?.n ?? 1,
    unit: rule.every?.unit ?? "days",
    runsMode: rule.runs === null ? "indefinite" : "count",
    runs: rule.every && rule.runs !== null ? rule.runs : 3,
  };
}

/// The rule the form describes, or why it describes none.
export function formRule(form: ScheduleForm): ScheduleRule | string {
  if (!startOf({ at: form.at })) return "Pick a start date and time";
  if (!form.repeat) return { at: form.at, every: null, runs: 1 };
  if (!Number.isInteger(form.n) || form.n < 1) return "Repeat at least every 1 " + form.unit.replace(/s$/, "");
  if (form.runsMode === "indefinite") return { at: form.at, every: { n: form.n, unit: form.unit }, runs: null };
  if (!Number.isInteger(form.runs) || form.runs < 1) return "Run it at least once";
  return { at: form.at, every: { n: form.n, unit: form.unit }, runs: form.runs };
}

export interface AgentChoice {
  id: string;
  label: string;
}

/// The profiles a scheduled run can launch headless.
export function headlessChoices(
  profiles: readonly { id: string; label: string; headlessArgs: string }[]
): AgentChoice[] {
  return profiles
    .filter((p) => scheduledRunArgs(p.id, p.headlessArgs) !== null)
    .map((p) => ({ id: p.id, label: p.label }));
}

/// Who will run the task: the agent it resolves to, when that one can
/// run headless; otherwise a pick among the ones that can -- written as
/// `agent:` on the copy -- and when none can, why scheduling is off.
export type AgentVerdict =
  | { kind: "ok"; label: string }
  | { kind: "pick"; choices: AgentChoice[]; why: string }
  | { kind: "blocked"; reason: string };

export function agentVerdict(
  resolved: { profileId: string; label?: string; headlessArgs: string },
  profiles: readonly { id: string; label: string; headlessArgs: string }[]
): AgentVerdict {
  const label = resolved.label || resolved.profileId;
  if (scheduledRunArgs(resolved.profileId, resolved.headlessArgs) !== null) return { kind: "ok", label };
  const choices = headlessChoices(profiles);
  if (choices.length === 0) {
    return { kind: "blocked", reason: "No agent set up here can run headless, so nothing can run a scheduled task" };
  }
  return { kind: "pick", choices, why: `${label} has no headless mode a scheduled run can use` };
}

/// Why a card cannot be scheduled, or null when it can (ADR 0010: task
/// cards only, for now).
export function scheduleCardBlocker(kind: string): string | null {
  if (kind === "task") return null;
  if (kind === "plan") return "plans can't be scheduled yet";
  return "only task cards can be scheduled";
}
