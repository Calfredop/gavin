// The activity calendar (`tbd-feat-activity-calendar.md`): what happened,
// drawn over time, zoomable year › month › day › hour.
//
// Activity is read from what gavin already keeps, never recorded anew:
// agent runs (the daemon's `card_runs` and standalone `tool_runs`, v78's
// `ActivityRuns`), and from git, commits on every ref, pushes off the
// remote-tracking reflogs, and the files those commits changed
// (`git_activity`). Everything crosses as UTC unix seconds; every bucket
// and label here is in the machine's own time zone, because "Tuesday" is
// the human's Tuesday.
//
// Pure and unit-tested. `ActivityCalendar.svelte` is a template over it
// and `activityLoad.ts` is the only part that talks to anything.

// ---- the wire -----------------------------------------------------------

/// One run, as `ActivityRuns` answers it (protocol `ActivityRun`).
export interface ActivityRun {
  kind: "card" | "tool";
  workspaceId: string;
  path: string | null;
  toolId: string | null;
  sessionId: string;
  command: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  outcome: string;
}

/// One commit, as `git_activity` answers it. `at` is the author date.
export interface ActivityCommit {
  sha: string;
  at: number;
  author: string;
  subject: string;
  files: string[];
}

/// One push that moved a remote-tracking ref. `oldSha` is null for the
/// push that created the ref.
export interface ActivityPush {
  at: number;
  remoteRef: string;
  oldSha: string | null;
  newSha: string;
}

export interface GitActivity {
  commits: ActivityCommit[];
  pushes: ActivityPush[];
}

/// One workspace's two reads, as the loader hands them over. `null` is a
/// read that did not happen -- blocked, failed, or a workspace with no
/// folder -- which is not the same as an empty one, and the loader says
/// which it was beside the calendar.
export interface WorkspaceActivity {
  workspaceId: string;
  workspaceName: string;
  runs: ActivityRun[] | null;
  git: GitActivity | null;
}

// ---- kinds --------------------------------------------------------------

export type ActivityKind = "runs" | "commits" | "pushes" | "files";

export const ACTIVITY_KINDS: readonly ActivityKind[] = ["runs", "commits", "pushes", "files"];

export const KIND_LABEL: Record<ActivityKind, string> = {
  runs: "Runs",
  commits: "Commits",
  pushes: "Pushes",
  files: "Files",
};

const KIND_NOUN: Record<ActivityKind, [string, string]> = {
  runs: ["run", "runs"],
  commits: ["commit", "commits"],
  pushes: ["push", "pushes"],
  files: ["file", "files"],
};

function counted(n: number, kind: ActivityKind): string {
  return `${n} ${KIND_NOUN[kind][n === 1 ? 0 : 1]}`;
}

/// The kind picker's toggle. Always in `ACTIVITY_KINDS` order, and never
/// empty: turning the last kind off would leave a calendar of nothing,
/// which reads as "nothing happened" rather than "you hid everything".
export function toggleKind(kinds: readonly ActivityKind[], kind: ActivityKind): ActivityKind[] {
  const on = new Set(kinds);
  if (on.has(kind)) {
    if (on.size === 1) return [...kinds];
    on.delete(kind);
  } else {
    on.add(kind);
  }
  return ACTIVITY_KINDS.filter((k) => on.has(k));
}

/// What the kind picker's button says.
export function kindSummary(kinds: readonly ActivityKind[]): string {
  if (ACTIVITY_KINDS.every((k) => kinds.includes(k))) return "All activity";
  return ACTIVITY_KINDS.filter((k) => kinds.includes(k))
    .map((k) => KIND_LABEL[k])
    .join(" · ");
}

// ---- events -------------------------------------------------------------

export type ActivityEvent =
  | { type: "run"; at: number; workspaceId: string; run: ActivityRun }
  | { type: "commit"; at: number; workspaceId: string; commit: ActivityCommit }
  | { type: "push"; at: number; workspaceId: string; push: ActivityPush };

const TYPE_ORDER: Record<ActivityEvent["type"], number> = { run: 0, commit: 1, push: 2 };

/// Every workspace's activity as one list, oldest first. A run counts at
/// its start and a commit at its author date.
///
/// Commits are one per sha across workspaces, and pushes one per ref
/// move: two workspaces on one repository -- a checkout and its worktree
/// -- read the same history, and counting it twice would double a day
/// that happened once. The first workspace to carry it keeps it.
export function buildEvents(sources: readonly WorkspaceActivity[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const shas = new Set<string>();
  const pushes = new Set<string>();
  for (const src of sources) {
    for (const run of src.runs ?? []) {
      events.push({ type: "run", at: run.startedAt, workspaceId: src.workspaceId, run });
    }
    for (const commit of src.git?.commits ?? []) {
      if (shas.has(commit.sha)) continue;
      shas.add(commit.sha);
      events.push({ type: "commit", at: commit.at, workspaceId: src.workspaceId, commit });
    }
    for (const push of src.git?.pushes ?? []) {
      const key = `${push.remoteRef}\u0000${push.at}\u0000${push.newSha}`;
      if (pushes.has(key)) continue;
      pushes.add(key);
      events.push({ type: "push", at: push.at, workspaceId: src.workspaceId, push });
    }
  }
  return events.sort((a, b) => a.at - b.at || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

// ---- buckets ------------------------------------------------------------

export interface Tally {
  runs: number;
  commits: number;
  pushes: number;
  /// Distinct files, keyed by workspace and path: one path in two repos
  /// is two files.
  files: Set<string>;
}

export interface Bucket extends Tally {
  byWorkspace: Map<string, Tally>;
}

/// Every event bucketed by local day and local hour, once. Zooming and
/// the kind picker only re-read this; nothing is re-bucketed.
export interface ActivityIndex {
  events: ActivityEvent[];
  days: Map<number, Bucket>;
  hours: Map<number, Bucket>;
}

/// A local calendar day as one number, `yyyymmdd`, `month` 0-based.
export function dayKey(year: number, month: number, day: number): number {
  return year * 10000 + (month + 1) * 100 + day;
}

/// A local hour, `yyyymmddhh`.
export function hourKey(year: number, month: number, day: number, hour: number): number {
  return dayKey(year, month, day) * 100 + hour;
}

function emptyTally(): Tally {
  return { runs: 0, commits: 0, pushes: 0, files: new Set() };
}

function add(t: Tally, e: ActivityEvent): void {
  if (e.type === "run") t.runs += 1;
  else if (e.type === "push") t.pushes += 1;
  else {
    t.commits += 1;
    for (const f of e.commit.files) t.files.add(`${e.workspaceId}\u0000${f}`);
  }
}

function bucketFor(map: Map<number, Bucket>, key: number): Bucket {
  let b = map.get(key);
  if (!b) {
    b = { ...emptyTally(), byWorkspace: new Map() };
    map.set(key, b);
  }
  return b;
}

export function indexEvents(events: ActivityEvent[]): ActivityIndex {
  const days = new Map<number, Bucket>();
  const hours = new Map<number, Bucket>();
  for (const e of events) {
    const d = new Date(e.at * 1000);
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    for (const b of [bucketFor(days, dayKey(y, m, day)), bucketFor(hours, hourKey(y, m, day, d.getHours()))]) {
      add(b, e);
      let w = b.byWorkspace.get(e.workspaceId);
      if (!w) {
        w = emptyTally();
        b.byWorkspace.set(e.workspaceId, w);
      }
      add(w, e);
    }
  }
  return { events, days, hours };
}

function countOf(t: Tally, kind: ActivityKind): number {
  return kind === "files" ? t.files.size : t[kind];
}

/// One cell's intensity input: the sum, over the kinds picked, of what
/// the cell holds.
export function cellValue(t: Tally | undefined, kinds: readonly ActivityKind[]): number {
  if (!t) return 0;
  let n = 0;
  for (const k of kinds) n += countOf(t, k);
  return n;
}

/// How many shades a non-empty cell can take.
export const LEVELS = 4;

/// Quantile levels over the non-empty cells on screen: 0 for an empty
/// cell, then 1..LEVELS by which quarter of the busy cells' values this
/// one falls past. Relative to the view rather than to a fixed scale, so
/// a quiet month still shows which of its days were the busy ones.
export function levelScale(values: readonly number[]): (value: number) => number {
  const busy = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (busy.length === 0) return () => 0;
  const at = (p: number) => busy[Math.floor(p * (busy.length - 1))];
  const thresholds = [at(0.25), at(0.5), at(0.75)];
  return (value) => (value <= 0 ? 0 : 1 + thresholds.filter((t) => value > t).length);
}

/// A cell's tooltip: its date, then what it holds by kind, then -- at app
/// level -- by workspace.
export function cellTip(
  label: string,
  t: Bucket | undefined,
  kinds: readonly ActivityKind[],
  workspaceNames: ReadonlyMap<string, string> | null
): string {
  const parts = (x: Tally) =>
    kinds
      .map((k) => [k, countOf(x, k)] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => counted(n, k))
      .join(" · ");
  const total = t ? parts(t) : "";
  if (!t || total === "") return `${label}\nNo activity`;
  const lines = [label, total];
  if (workspaceNames && workspaceNames.size > 1) {
    for (const [id, w] of t.byWorkspace) {
      const line = parts(w);
      if (line) lines.push(`${workspaceNames.get(id) ?? id}: ${line}`);
    }
  }
  return lines.join("\n");
}

// ---- the calendar's geometry ---------------------------------------------

export type Zoom = "year" | "month" | "day" | "hour";

/// Where the calendar is looking: a zoom level and the local date parts
/// of the period it shows. Parts below the zoom are kept, so zooming out
/// and back in lands where it was.
export interface Focus {
  zoom: Zoom;
  year: number;
  month: number;
  day: number;
  hour: number;
}

export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Monday-first, the way most calendars outside the US draw a week.
export const WEEK_STARTS_ON = 1;

/// The Year view's width: 53 columns, so the week holding today and the
/// 52 before it -- the last twelve months, whole weeks.
export const YEAR_WEEKS = 53;

export function focusAt(zoom: Zoom, nowMs: number): Focus {
  const d = new Date(nowMs);
  return { zoom, year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours() };
}

/// Weekday labels in row order.
export function weekdayLabels(weekStartsOn = WEEK_STARTS_ON): string[] {
  return Array.from({ length: 7 }, (_, i) => WEEKDAY_LABELS[(weekStartsOn + i) % 7]);
}

function rowOf(date: Date, weekStartsOn: number): number {
  return (date.getDay() - weekStartsOn + 7) % 7;
}

/// The first day the Year view draws -- and so the first instant the
/// calendar asks for: local midnight, 52 weeks before the start of this
/// week.
export function yearStart(nowMs: number, weekStartsOn = WEEK_STARTS_ON): Date {
  const today = new Date(nowMs);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - rowOf(today, weekStartsOn) - (YEAR_WEEKS - 1) * 7);
}

/// The end of today, local: the last instant the calendar draws.
export function todayEnd(nowMs: number): Date {
  const today = new Date(nowMs);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
}

/// What the loader asks for, in the wire's seconds.
export function loadWindow(nowMs: number, weekStartsOn = WEEK_STARTS_ON): { since: number; until: number } {
  return {
    since: Math.floor(yearStart(nowMs, weekStartsOn).getTime() / 1000),
    until: Math.floor(todayEnd(nowMs).getTime() / 1000),
  };
}

export interface DayCell {
  key: number;
  year: number;
  month: number;
  day: number;
  /// After today: drawn as empty, never clickable.
  future: boolean;
}

export interface YearCell extends DayCell {
  col: number;
  row: number;
}

export interface YearGrid {
  cells: YearCell[];
  /// A label where a month's first column is, skipping one that would
  /// sit on top of the label before it.
  months: { label: string; col: number; year: number; month: number }[];
}

function dayCell(date: Date, todayKey: number): DayCell {
  const key = dayKey(date.getFullYear(), date.getMonth(), date.getDate());
  return { key, year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), future: key > todayKey };
}

function todayKeyOf(nowMs: number): number {
  const t = new Date(nowMs);
  return dayKey(t.getFullYear(), t.getMonth(), t.getDate());
}

/// The Year view: `YEAR_WEEKS` columns of seven days, today in the last.
/// Built day by day through the Date constructor, never by adding
/// 86 400 000 ms, so a daylight-saving change does not shift a column.
export function yearGrid(nowMs: number, weekStartsOn = WEEK_STARTS_ON): YearGrid {
  const start = yearStart(nowMs, weekStartsOn);
  const todayKey = todayKeyOf(nowMs);
  const cells: YearCell[] = [];
  const months: YearGrid["months"] = [];
  for (let i = 0; i < YEAR_WEEKS * 7; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const col = Math.floor(i / 7);
    cells.push({ ...dayCell(date, todayKey), col, row: i % 7 });
    if (i % 7 === 0) {
      const prev = months.at(-1);
      const firstOfMonthIn = date.getDate() <= 7;
      if (firstOfMonthIn && (!prev || (prev.month !== date.getMonth() && col - prev.col >= 3))) {
        months.push({ label: MONTH_LABELS[date.getMonth()], col, year: date.getFullYear(), month: date.getMonth() });
      }
    }
  }
  return { cells, months };
}

export interface MonthGrid {
  /// Blank cells before the 1st, so it lands under its weekday.
  lead: number;
  days: DayCell[];
}

export function monthGrid(year: number, month: number, nowMs: number, weekStartsOn = WEEK_STARTS_ON): MonthGrid {
  const first = new Date(year, month, 1);
  const todayKey = todayKeyOf(nowMs);
  const days: DayCell[] = [];
  for (let d = 1; new Date(year, month, d).getMonth() === first.getMonth(); d++) {
    days.push(dayCell(new Date(year, month, d), todayKey));
  }
  return { lead: rowOf(first, weekStartsOn), days };
}

export interface HourCell {
  key: number;
  hour: number;
  future: boolean;
}

export function dayHours(year: number, month: number, day: number, nowMs: number): HourCell[] {
  const nowHour = (() => {
    const t = new Date(nowMs);
    return hourKey(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours());
  })();
  return Array.from({ length: 24 }, (_, hour) => {
    const key = hourKey(year, month, day, hour);
    return { key, hour, future: key > nowHour };
  });
}

/// The period a focus shows, as local-time instants `[start, end)`. The
/// Year view's period is the whole loaded window.
export function periodBounds(f: Focus, nowMs: number, weekStartsOn = WEEK_STARTS_ON): { start: number; end: number } {
  switch (f.zoom) {
    case "year":
      return { start: yearStart(nowMs, weekStartsOn).getTime(), end: todayEnd(nowMs).getTime() };
    case "month":
      return { start: new Date(f.year, f.month, 1).getTime(), end: new Date(f.year, f.month + 1, 1).getTime() };
    case "day":
      return { start: new Date(f.year, f.month, f.day).getTime(), end: new Date(f.year, f.month, f.day + 1).getTime() };
    case "hour":
      return {
        start: new Date(f.year, f.month, f.day, f.hour).getTime(),
        end: new Date(f.year, f.month, f.day, f.hour + 1).getTime(),
      };
  }
}

// ---- navigation ---------------------------------------------------------

/// A click on a cell: the Year view's and the Month view's cells are
/// days, the Day view's are hours.
export function zoomInto(f: Focus, target: { zoom: Zoom; year?: number; month?: number; day?: number; hour?: number }): Focus {
  return {
    zoom: target.zoom,
    year: target.year ?? f.year,
    month: target.month ?? f.month,
    day: target.day ?? f.day,
    hour: target.hour ?? f.hour,
  };
}

/// A breadcrumb click: the same parts at a wider zoom.
export function zoomOutTo(f: Focus, zoom: Zoom): Focus {
  return { ...f, zoom };
}

function normalised(zoom: Zoom, date: Date): Focus {
  return { zoom, year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), hour: date.getHours() };
}

/// ←/→: the next or previous period at the same zoom, or null past the
/// edge of what was loaded -- the Year view is the whole of it, so it
/// never steps, and nothing steps into the future.
export function step(f: Focus, dir: -1 | 1, nowMs: number, weekStartsOn = WEEK_STARTS_ON): Focus | null {
  let next: Focus;
  switch (f.zoom) {
    case "year":
      return null;
    case "month": {
      const day = Math.min(f.day, new Date(f.year, f.month + dir + 1, 0).getDate());
      next = { ...normalised("month", new Date(f.year, f.month + dir, day, f.hour)) };
      break;
    }
    case "day":
      next = normalised("day", new Date(f.year, f.month, f.day + dir, f.hour));
      break;
    case "hour":
      next = normalised("hour", new Date(f.year, f.month, f.day, f.hour + dir));
      break;
  }
  const range = periodBounds({ ...f, zoom: "year" }, nowMs, weekStartsOn);
  const p = periodBounds(next, nowMs, weekStartsOn);
  if (p.end <= range.start || p.start >= Math.min(range.end, nowMs + 1)) return null;
  return next;
}

export interface Crumb {
  label: string;
  zoom: Zoom;
  current: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/// `2026 › Oct › 21 › 14:00`, each crumb zooming out to its level. At the
/// Year view the one crumb names the rolling window it is.
export function breadcrumb(f: Focus): Crumb[] {
  if (f.zoom === "year") return [{ label: "Last 12 months", zoom: "year", current: true }];
  const order: Zoom[] = ["year", "month", "day", "hour"];
  const label: Record<Zoom, string> = {
    year: String(f.year),
    month: MONTH_LABELS[f.month],
    day: String(f.day),
    hour: `${pad2(f.hour)}:00`,
  };
  return order.slice(0, order.indexOf(f.zoom) + 1).map((z) => ({ label: label[z], zoom: z, current: z === f.zoom }));
}

/// A day as a tooltip names it: `Tue 21 Oct 2026`.
export function dayLabel(year: number, month: number, day: number): string {
  return `${WEEKDAY_LABELS[new Date(year, month, day).getDay()]} ${day} ${MONTH_LABELS[month]} ${year}`;
}

export function hourLabel(hour: number): string {
  return `${pad2(hour)}:00`;
}

// ---- the leaf list ------------------------------------------------------

/// The events in `[startMs, endMs)` that the picked kinds draw, oldest
/// first. A commit is listed when Commits OR Files is picked: Files has
/// no row of its own, and a commit's row is where its files are.
export function eventsIn(
  events: readonly ActivityEvent[],
  startMs: number,
  endMs: number,
  kinds: readonly ActivityKind[]
): ActivityEvent[] {
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].at < startSec) lo = mid + 1;
    else hi = mid;
  }
  const out: ActivityEvent[] = [];
  for (let i = lo; i < events.length && events[i].at < endSec; i++) {
    const e = events[i];
    if (e.type === "run" ? kinds.includes("runs") : e.type === "push" ? kinds.includes("pushes") : kinds.includes("commits") || kinds.includes("files")) {
      out.push(e);
    }
  }
  return out;
}

/// `14:05`, local.
export function clockLabel(at: number): string {
  const d = new Date(at * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/// How long a run took, coarse; null for one whose end nobody saw.
export function runDuration(run: ActivityRun, nowSec: number): string | null {
  const end = run.endedAt ?? (run.outcome === "running" ? nowSec : null);
  if (end === null) return null;
  const secs = Math.max(0, end - run.startedAt);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/// Card titles by path, off the workspace's loaded tree.
export function cardTitles(contexts: readonly { plans: readonly { path: string; title: string }[] }[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const ctx of contexts ?? []) for (const p of ctx.plans) if (p.title.trim()) out.set(p.path, p.title);
  return out;
}

/// What a run's row is called: the card's title from its board, else the
/// card file's name -- an archived card is off the board but its runs are
/// still activity -- and a tool's name, else its id.
export function runTitle(run: ActivityRun, titles: ReadonlyMap<string, string> | undefined, toolName?: string | null): string {
  if (run.kind === "card") {
    const path = run.path ?? "";
    return titles?.get(path) ?? path.split("/").at(-1) ?? path;
  }
  return toolName ?? run.toolId ?? "tool";
}

/// A push's range: `a1b2c3d → e4f5a6b`, or `new → e4f5a6b` for the push
/// that made the ref.
export function pushRange(push: ActivityPush): string {
  const short = (s: string) => s.slice(0, 7);
  return `${push.oldSha ? short(push.oldSha) : "new"} → ${short(push.newSha)}`;
}

/// The outcome a run's badge reads. A tool run's verdict words are
/// `passed`/`failed`; the run vocabulary's are `exited` with a code.
export function badgeOutcome(run: ActivityRun): { outcome: string; exitCode: number | null } {
  if (run.kind === "tool") {
    if (run.outcome === "passed") return { outcome: "exited", exitCode: 0 };
    if (run.outcome === "failed") return { outcome: "failed", exitCode: run.exitCode };
  }
  return { outcome: run.outcome, exitCode: run.exitCode };
}
