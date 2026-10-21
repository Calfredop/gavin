// The wire shapes of Scheduled tasks (v77, ADR 0010), mirroring
// `protocol::scheduled`. A Scheduled task is a copy of a task card under
// `.gavin-root/scheduled/` that runs headless on its own schedule; the
// daemon keeps the copies and their run state, and this app decides when
// a fire is due.

export type IntervalUnit = "minutes" | "hours" | "days" | "weeks";

/// A parsed `schedule:` line. `at` is `YYYY-MM-DDTHH:MM` in this
/// machine's local time; `every` is null for a single shot; `runs` is
/// null for indefinite and always 1 for a single shot.
export type ScheduleRule = {
  at: string;
  every: { n: number; unit: IntervalUnit } | null;
  runs: number | null;
};

/// `launching` (claimed, its session not yet recorded), `running`,
/// `exited`, `skipped` (with `skipReason`), `failed` (the launch itself
/// failed, `skipReason` says why) or `abandoned` (it ended unwatched).
export type FireOutcome = "launching" | "running" | "exited" | "skipped" | "failed" | "abandoned";

export type ScheduledFire = {
  id: number;
  /// The grid slot it claimed; null for a Run now.
  slot: number | null;
  /// Epoch seconds.
  at: number;
  outcome: FireOutcome;
  skipReason: string | null;
  sessionId: string | null;
  exitCode: number | null;
  endedAt: number | null;
  reportPath: string | null;
  /// The Run report's `#` headline, when it wrote one.
  headline: string | null;
  hasReport: boolean;
  hasRaw: boolean;
};

export type ScheduledTask = {
  path: string;
  name: string;
  title: string;
  agent: string | null;
  model: string | null;
  effort: string | null;
  complexity: string | null;
  /// The file name of the card it was copied from.
  from: string | null;
  /// The `schedule:` line as written; null once unscheduled.
  schedule: string | null;
  rule: ScheduleRule | null;
  scheduleError: string | null;
  paused: boolean;
  body: string;
  /// Counted fires, launched and skipped. Run now never counts.
  fireCount: number;
  lastSlot: number | null;
  /// Newest first, at most twenty.
  fires: ScheduledFire[];
};

/// The answer to a fire claim. Launch only when `claimed` and not
/// `skipped`.
export type FireClaim = {
  claimed: boolean;
  fireId: number | null;
  /// 1-based among counted fires; null for a Run now.
  fireNumber: number | null;
  reportPath: string | null;
  skipped: string | null;
  why: string | null;
};

export type ScheduledReportText = { markdown: string | null; raw: string | null };

/// The fields `setScheduledTaskField` writes.
export type ScheduledTaskField =
  | "title"
  | "agent"
  | "model"
  | "effort"
  | "complexity"
  | "schedule"
  | "paused"
  | "body";
