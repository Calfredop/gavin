// The Workspace log (v79, ADR 0011): what happened in a workspace, one
// entry per event, recorded by the daemon as it happened. This module is
// the Log tab's logic -- the sentence each entry reads as, the day it
// falls under, the filter, the merge of live pushes into the loaded
// pages, and whether a card it names can still be opened. Pure, so it is
// tested here; WorkspaceLogHubView.svelte is a template over it.
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";

export type LogKind =
  | "card_created"
  | "card_deleted"
  | "card_archived"
  | "card_unarchived"
  | "card_moved"
  | "card_retitled"
  | "run_started"
  | "run_finished"
  | "rail_created"
  | "rail_started"
  | "rail_paused"
  | "rail_resumed"
  | "rail_finished"
  | "rail_failed"
  | "rail_deleted"
  | "decision_filed"
  | "decision_answered"
  | "test_filed"
  | "test_passed"
  | "test_failed"
  | "scheduled_fired"
  | "git_commit"
  | "git_checkout"
  | "git_merge"
  | "git_pull"
  | "git_rebase"
  | "git_reset"
  | "git_push"
  | "git_branch_deleted"
  /// A newer daemon's kind this build does not know.
  | "unknown";

/// The six families the filter picks among, in the daemon's spelling.
export type LogCategory = "cards" | "runs" | "rails" | "human" | "scheduled" | "git";

export const LOG_CATEGORIES: readonly LogCategory[] = ["cards", "runs", "rails", "human", "scheduled", "git"];

export const CATEGORY_LABEL: Record<LogCategory, string> = {
  cards: "Cards",
  runs: "Runs",
  rails: "Rails",
  human: "Human items",
  scheduled: "Scheduled",
  git: "Git",
};

/// What an entry is about; each kind fills the fields it has.
export interface LogPayload {
  cardFile?: string;
  cardPath?: string;
  cardTitle?: string;
  oldTitle?: string;
  fromColumn?: string;
  toColumn?: string;
  railId?: string;
  railName?: string;
  itemText?: string;
  itemOutcome?: string;
  scheduledPath?: string;
  fireNumber?: number;
  agent?: string;
  sessionId?: string;
  exitCode?: number;
  branch?: string;
  worktree?: string;
  sha?: string;
  message?: string;
  reason?: string;
  noticedOnStart?: boolean;
}

export interface LogEntry {
  id: number;
  workspaceId: string;
  /// UTC unix seconds.
  at: number;
  kind: LogKind | string;
  payload: LogPayload;
}

/// Where the next page starts: strictly older than this entry.
export interface LogCursor {
  at: number;
  id: number;
}

export interface WorkspaceLogPage {
  entries: LogEntry[];
  more: boolean;
}

/// A page's size. Enough to fill a tall window and leave something to
/// scroll into, small enough that a page is never a wait.
export const LOG_PAGE_SIZE = 100;

export function categoryOf(kind: string): LogCategory | null {
  if (kind.startsWith("card_")) return "cards";
  if (kind.startsWith("run_")) return "runs";
  if (kind.startsWith("rail_")) return "rails";
  if (kind.startsWith("decision_") || kind.startsWith("test_")) return "human";
  if (kind.startsWith("scheduled_")) return "scheduled";
  if (kind.startsWith("git_")) return "git";
  return null;
}

// ---- the filter ---------------------------------------------------------

/// Turns one family on or off. The last one on stays on: a log filtered
/// to nothing reads as a workspace where nothing happened.
export function toggleCategory(on: readonly LogCategory[], category: LogCategory): LogCategory[] {
  const set = new Set(on);
  if (set.has(category)) {
    if (set.size === 1) return [...on];
    set.delete(category);
  } else {
    set.add(category);
  }
  return LOG_CATEGORIES.filter((c) => set.has(c));
}

/// What the filter's button says.
export function categorySummary(on: readonly LogCategory[]): string {
  if (LOG_CATEGORIES.every((c) => on.includes(c))) return "All activity";
  return LOG_CATEGORIES.filter((c) => on.includes(c))
    .map((c) => CATEGORY_LABEL[c])
    .join(" · ");
}

/// What the daemon is asked for: no families named means every one,
/// which also keeps a kind this build does not know visible.
export function categoriesForQuery(on: readonly LogCategory[]): LogCategory[] {
  return LOG_CATEGORIES.every((c) => on.includes(c)) ? [] : LOG_CATEGORIES.filter((c) => on.includes(c));
}

/// The daemon's search, asked of an entry here: card names, rail names,
/// git branches and worktrees, ignoring case. What decides whether a live
/// push belongs in the list the query drew.
export function matchesSearch(entry: LogEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const p = entry.payload;
  return [p.cardTitle, p.oldTitle, p.cardFile, p.railName, p.branch, p.worktree].some(
    (field) => field !== undefined && field.toLowerCase().includes(needle)
  );
}

export function matchesFilter(entry: LogEntry, on: readonly LogCategory[], search: string): boolean {
  const category = categoryOf(entry.kind);
  const every = LOG_CATEGORIES.every((c) => on.includes(c));
  if (!every && (category === null || !on.includes(category))) return false;
  return matchesSearch(entry, search);
}

// ---- the list -----------------------------------------------------------

/// Newest first: by time, then by id -- a git entry carries its reflog's
/// time, which can be older than rows written before it.
export function newestFirst(a: LogEntry, b: LogEntry): number {
  return b.at - a.at || b.id - a.id;
}

/// Entries merged into the loaded list, each once, newest first. Both a
/// live push and a page can carry an entry the list already has.
export function mergeEntries(list: readonly LogEntry[], incoming: readonly LogEntry[]): LogEntry[] {
  const byId = new Map<number, LogEntry>();
  for (const e of list) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort(newestFirst);
}

/// Where the next page starts: the oldest entry loaded.
export function nextCursor(list: readonly LogEntry[]): LogCursor | null {
  const last = list.at(-1);
  return last ? { at: last.at, id: last.id } : null;
}

/// A push's entries that belong in the list the current query drew. An
/// entry older than the oldest loaded one waits for the page that reaches
/// it, so the list never has a hole above its bottom.
export function pushedIntoView(
  list: readonly LogEntry[],
  pushed: readonly LogEntry[],
  workspaceId: string,
  on: readonly LogCategory[],
  search: string,
  more: boolean
): LogEntry[] {
  const oldest = nextCursor(list);
  return pushed.filter((e) => {
    if (e.workspaceId !== workspaceId || !matchesFilter(e, on, search)) return false;
    if (!more || !oldest) return true;
    return newestFirst(e, { ...e, at: oldest.at, id: oldest.id }) <= 0;
  });
}

// ---- days and times -----------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/// A day's heading, in this machine's time zone.
export function dayLabel(at: number, now: Date): string {
  const d = new Date(at * 1000);
  if (dayKey(d) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function timeLabel(at: number): string {
  const d = new Date(at * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface LogDay {
  key: string;
  label: string;
  entries: LogEntry[];
}

/// A newest-first list cut into days.
export function groupByDay(entries: readonly LogEntry[], now: Date): LogDay[] {
  const days: LogDay[] = [];
  for (const e of entries) {
    const key = dayKey(new Date(e.at * 1000));
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(e);
    else days.push({ key, label: dayLabel(e.at, now), entries: [e] });
  }
  return days;
}

// ---- the sentence -------------------------------------------------------

/// One piece of a row's sentence. `card` and `rail` are the links; `name`
/// is set off the way a link is, without being one -- a branch, a column.
export type SentencePart =
  | { type: "text"; text: string }
  | { type: "name"; text: string }
  | { type: "card"; text: string }
  | { type: "rail"; text: string };

const text = (t: string): SentencePart => ({ type: "text", text: t });
const name = (t: string): SentencePart => ({ type: "name", text: t });

function cardName(p: LogPayload): string {
  return p.cardTitle?.trim() || p.cardFile || "a card";
}

function column(c: string | undefined): string {
  return c?.trim() || "no column";
}

/// The folder a checkout is in, for a git sentence; nothing for the main
/// checkout, which a sentence need not name.
export function worktreeLabel(worktree: string | undefined, rootPath: string | null): string | null {
  if (!worktree) return null;
  const trim = (p: string) => p.replace(/[\\/]+$/, "");
  if (rootPath && trim(worktree) === trim(rootPath)) return null;
  return trim(worktree).split(/[\\/]/).at(-1) || worktree;
}

function gitWhere(p: LogPayload, rootPath: string | null): SentencePart[] {
  const parts: SentencePart[] = [];
  if (p.branch) parts.push(text(" on "), name(p.branch));
  const wt = worktreeLabel(p.worktree, rootPath);
  if (wt) parts.push(text(" in "), name(wt));
  return parts;
}

function withDetail(parts: SentencePart[], detail: string | undefined): SentencePart[] {
  return detail?.trim() ? [...parts, text(`: ${detail.trim()}`)] : parts;
}

/// The one-line sentence a row reads as. `rootPath` is the workspace's
/// own folder, so a git entry in the main checkout does not name it.
export function sentenceOf(entry: LogEntry, rootPath: string | null): SentencePart[] {
  const p = entry.payload;
  const card: SentencePart = { type: "card", text: cardName(p) };
  const rail: SentencePart = { type: "rail", text: p.railName?.trim() || "a rail" };
  switch (entry.kind) {
    case "card_created":
      return [text("Card "), card, text(" created")];
    case "card_deleted":
      return [text("Card "), card, text(" deleted")];
    case "card_archived":
      return [text("Card "), card, text(" archived")];
    case "card_unarchived":
      return [text("Card "), card, text(" restored from the archive")];
    case "card_moved":
      return [text("Card "), card, text(` moved ${column(p.fromColumn)} → ${column(p.toColumn)}`)];
    case "card_retitled":
      return [text("Card "), name(p.oldTitle?.trim() || "untitled"), text(" renamed to "), card];
    case "run_started":
      return [text("Run started on "), card, ...(p.agent ? [text(" with "), name(p.agent)] : [])];
    case "run_finished": {
      const how = [p.agent, p.exitCode !== undefined ? `exit ${p.exitCode}` : null].filter(Boolean).join(", ");
      return [text("Run finished on "), card, ...(how ? [text(` (${how})`)] : [])];
    }
    case "rail_created":
      return [text("Rail "), rail, text(" created")];
    case "rail_started":
      return [text("Rail "), rail, text(" started")];
    case "rail_paused":
      return [text("Rail "), rail, text(" paused")];
    case "rail_resumed":
      return [text("Rail "), rail, text(" resumed")];
    case "rail_finished":
      return [text("Rail "), rail, text(" finished")];
    case "rail_failed":
      return withDetail([text("Rail "), rail, text(" stalled")], p.reason);
    case "rail_deleted":
      return [text("Rail "), rail, text(" deleted")];
    case "decision_filed":
      return withDetail([text("Decision filed on "), card], p.itemText);
    case "decision_answered":
      return withDetail([text("Decision answered on "), card], p.itemText);
    case "test_filed":
      return withDetail([text("Human test filed on "), card], p.itemText);
    case "test_passed":
      return withDetail([text("Human test passed on "), card], p.itemText);
    case "test_failed":
      return withDetail([text("Human test failed on "), card], p.itemText);
    case "scheduled_fired":
      return [
        text("Scheduled task "),
        name(p.cardTitle?.trim() || p.scheduledPath?.split("/").at(-1) || "a task"),
        text(p.fireNumber ? ` fired (run ${p.fireNumber})` : " ran now"),
      ];
    case "git_commit":
      return withDetail([text("Commit"), ...gitWhere(p, rootPath)], p.message);
    case "git_checkout": {
      const wt = worktreeLabel(p.worktree, rootPath);
      return [text("Checked out "), name(p.branch || "a detached HEAD"), ...(wt ? [text(" in "), name(wt)] : [])];
    }
    case "git_merge":
      return withDetail([text("Merge"), ...gitWhere(p, rootPath)], p.message);
    case "git_pull":
      return withDetail([text("Pull"), ...gitWhere(p, rootPath)], p.message);
    case "git_rebase":
      return [text("Rebase finished"), ...gitWhere(p, rootPath)];
    case "git_reset":
      return withDetail([text("Reset"), ...gitWhere(p, rootPath)], p.message);
    case "git_push":
      return [text("Pushed "), name(p.branch || "a branch")];
    case "git_branch_deleted": {
      const wt = worktreeLabel(p.worktree, rootPath);
      return [text("Branch "), name(p.branch || "?"), text(" deleted"), ...(wt ? [text(" in "), name(wt)] : [])];
    }
    default:
      return [text(`Something this version of gavin does not know happened (${entry.kind})`)];
  }
}

/// The sentence as plain text, for a tooltip or a test.
export function sentenceText(parts: readonly SentencePart[]): string {
  return parts.map((p) => p.text).join("");
}

/// The icon a row wears, by name; the view maps names to components.
export function iconFor(kind: string): string {
  switch (kind) {
    case "card_created":
      return "FilePlus";
    case "card_deleted":
      return "FileX";
    case "card_archived":
      return "Archive";
    case "card_unarchived":
      return "ArchiveRestore";
    case "card_moved":
      return "ArrowRightLeft";
    case "card_retitled":
      return "PenLine";
    case "run_started":
      return "Play";
    case "run_finished":
      return "CircleStop";
    case "rail_paused":
      return "Pause";
    case "rail_finished":
      return "CircleCheck";
    case "rail_failed":
      return "CircleX";
    case "decision_filed":
    case "decision_answered":
      return "Gavel";
    case "test_filed":
    case "test_passed":
    case "test_failed":
      return "FlaskConical";
    case "scheduled_fired":
      return "CalendarClock";
    case "git_commit":
      return "GitCommitHorizontal";
    case "git_checkout":
      return "GitBranch";
    case "git_merge":
      return "GitMerge";
    case "git_pull":
      return "ArrowDownToLine";
    case "git_rebase":
      return "GitBranch";
    case "git_reset":
      return "RotateCcw";
    case "git_push":
      return "ArrowUpFromLine";
    case "git_branch_deleted":
      return "Trash2";
    default:
      return categoryOf(kind) === "rails" ? "Waypoints" : "ScrollText";
  }
}

/// What a row's "noticed on start" mark says when hovered.
export const NOTICED_ON_START_TIP =
  "Changed while gavin was not watching this workspace. The time is when it was noticed, not when it happened.";

// ---- the card a row names -----------------------------------------------

/// A card a row can open, or why it cannot be.
export type CardTarget = { state: "open"; path: string } | { state: "gone" } | { state: "unknown" };

/// Card files the loaded list says were deleted and not made again since.
/// Newest first, so the first create-or-delete met for a file is its last.
export function deletedCards(entries: readonly LogEntry[]): Set<string> {
  const settled = new Set<string>();
  const gone = new Set<string>();
  for (const e of [...entries].sort(newestFirst)) {
    const file = e.payload.cardFile;
    if (!file || settled.has(file)) continue;
    if (e.kind === "card_deleted") {
      gone.add(file);
      settled.add(file);
    } else if (e.kind === "card_created") {
      settled.add(file);
    }
  }
  return gone;
}

/// The context folder a card path belongs to: the part before its
/// `.gavin-root/` or `.gavin/`.
function contextOf(path: string | undefined): string | null {
  if (!path) return null;
  const m = path.match(/^(.*?)[\\/]\.gavin(?:-root)?[\\/]plans[\\/]/);
  return m ? m[1] : null;
}

/// Where a row's card is now: found by file name across `plans/`,
/// `plans/done/` and `plans/archive/` -- the tree holds all three -- in
/// the context it was in when it can be, else anywhere. Gone once the log
/// says it was deleted; unknown when it is simply not there.
export function cardTarget(entry: LogEntry, tree: GavinTree | undefined, deleted: ReadonlySet<string>): CardTarget {
  const file = entry.payload.cardFile;
  if (!file) return { state: "unknown" };
  if (deleted.has(file)) return { state: "gone" };
  const want = contextOf(entry.payload.cardPath);
  const matches: { context: string; plan: PlanFileInfo }[] = [];
  for (const ctx of tree?.contexts ?? []) {
    for (const plan of ctx.plans) {
      if (plan.fileName === file) matches.push({ context: ctx.folderPath, plan });
    }
  }
  const found = matches.find((m) => m.context === want) ?? matches[0];
  return found ? { state: "open", path: found.plan.path } : { state: "unknown" };
}

// ---- clearing -----------------------------------------------------------

export interface ClearOption {
  label: string;
  /// UTC unix seconds; entries older than this go. Null clears them all.
  olderThan: number | null;
}

/// The Clear older than… menu, measured back from `now` on the calendar.
export function clearOptions(now: Date): ClearOption[] {
  const back = (months: number) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() - months);
    return Math.floor(d.getTime() / 1000);
  };
  return [
    { label: "1 month", olderThan: back(1) },
    { label: "3 months", olderThan: back(3) },
    { label: "6 months", olderThan: back(6) },
    { label: "1 year", olderThan: back(12) },
    { label: "Everything", olderThan: null },
  ];
}

/// The confirmation a clear asks for.
export function clearConfirm(option: ClearOption): { title: string; lines: string[]; confirmLabel: string } {
  const everything = option.olderThan === null;
  return {
    title: everything ? "Clear this workspace's whole log?" : `Clear log entries older than ${option.label}?`,
    lines: [
      everything ? "Every entry goes, and cannot be brought back." : "Those entries go, and cannot be brought back.",
      "Cards, runs and their history stay exactly as they are; only the log forgets.",
    ],
    confirmLabel: everything ? "Clear the whole log" : `Clear older than ${option.label}`,
  };
}
