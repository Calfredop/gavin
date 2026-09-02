// What the task manager knows and says: every session the daemon is
// holding, whether or not anything in the app is showing it.
//
// Pure, because the two things that are easy to get wrong here are
// arithmetic and wording. The CPU figure is a rate computed from two
// samples of a counter that can go backwards; the confirmations name a
// process that is about to be killed. Neither should need a daemon, a
// terminal or a DOM to test.
//
// The daemon's own reporting lives in orphan.ts, and this file
// deliberately reuses it rather than growing a second vocabulary for the
// same fact: a surviving orphan IS the sharpest case this panel exists
// for -- an invisible session with a stale indicator -- and describing it
// twice is how the two surfaces end up disagreeing.

import { describeOrphan, type OrphanProcess } from "./orphan";
import { findSessionLocation, type Workspace } from "./workspace";

/// One row as the Rust host hands it over (session::ManagedSession):
/// what the daemon knows, joined with one sample of what it costs.
export interface ManagedSession {
  id: string;
  workspacePath: string;
  cwd: string;
  /// The daemon's own status string, which unlike the app's
  /// `SessionStatus` includes "exited" -- this list does not filter
  /// those out, and a row that has ended is exactly the kind the panel
  /// exists to account for.
  status: string;
  restored: boolean;
  interrupted: boolean;
  orphan: OrphanProcess | null;
  command: string | null;
  /// The pid the daemon verified is still this session's own process.
  /// Null means there is nothing running to measure.
  pid: number | null;
  rssBytes: number;
  /// Cumulative CPU microseconds of this session's whole process tree.
  cpuTimeUs: number;
  processCount: number;
  sampledAtUs: number;
}

export interface ManagedSessions {
  sessions: ManagedSession[];
  /// False when the daemon has no `SessionProcesses` request to ask, so
  /// every figure in every row is a zero nobody measured.
  metrics: boolean;
}

/// Why a row is worth a second look. Ordered by how much is at stake: a
/// survivor is still editing the checkout, an exited row is a record
/// with nothing behind it, an interrupted one is a shell wearing a
/// run's id.
///
/// `restored` is deliberately not here. A restored shell lost its
/// scrollback and nothing else, and marking every one of them after a
/// daemon restart is how a stale indicator stops meaning anything.
export type Staleness = "orphaned" | "exited" | "interrupted";

export interface SessionRow {
  id: string;
  /// What to call it: the human's own name for the tab, else the command
  /// it was launched with, else "shell".
  label: string;
  command: string | null;
  cwd: string;
  status: string;
  /// The workspace this session belongs to, by name, or null when no
  /// open workspace claims it.
  workspaceName: string | null;
  /// Where a human can already see it -- a page name, or "Home" for the
  /// main agent panel. Null when nothing is showing it.
  where: string | null;
  visible: boolean;
  staleness: Staleness | null;
  stale: boolean;
  /// One line saying what the staleness means, or null.
  note: string | null;
  /// Share of one CPU over the interval between the last two samples, so
  /// 300 is three cores. Null when there is no interval yet, nothing was
  /// measured, or the two samples are not comparable.
  cpuPercent: number | null;
  /// Resident bytes of the whole process tree, or null when nothing was
  /// measured.
  memBytes: number | null;
  processCount: number;
  pid: number | null;
  orphan: OrphanProcess | null;
}

/// The two numbers a rate needs, plus what makes two of them comparable.
export interface CpuSample {
  cpuTimeUs: number;
  sampledAtUs: number;
  pid: number | null;
  processCount: number;
}

/// Share of one CPU between two samples, or null when the pair cannot
/// honestly produce one.
///
/// Every null here is a case where a number would be a lie:
///
/// - no previous sample: a counter is not a rate.
/// - a different pid: the session's process was replaced between polls,
///   so the two counters belong to different processes and their
///   difference measures nothing.
/// - a zero or backwards interval: two readings at the same instant, or
///   a clock that moved.
/// - nothing measured now: `processCount` 0 is the daemon saying it
///   looked and found nothing, which must not render as a confident
///   0.0%.
///
/// A SHRINKING counter is different, and is floored rather than nulled:
/// per process the counter only climbs, but this covers a TREE, and a
/// child exiting between samples takes its share of the total with it.
/// The session really did use no measurable CPU in that window.
export function cpuShare(now: CpuSample, before: CpuSample | null): number | null {
  if (!before) return null;
  if (now.processCount === 0) return null;
  if (now.pid === null || before.pid === null || now.pid !== before.pid) return null;
  const interval = now.sampledAtUs - before.sampledAtUs;
  if (interval <= 0) return null;
  const used = now.cpuTimeUs - before.cpuTimeUs;
  return Math.max(0, (used / interval) * 100);
}

function staleness(s: ManagedSession): Staleness | null {
  if (s.orphan) return "orphaned";
  if (s.status === "exited") return "exited";
  if (s.interrupted) return "interrupted";
  return null;
}

function note(s: ManagedSession, tone: Staleness | null): string | null {
  switch (tone) {
    case "orphaned":
      return (
        `The daemon restarted while this was working, and it did not stop. ` +
        `${describeOrphan(s.orphan!)} is still running in ${s.cwd} with nothing in front of it.`
      );
    case "exited":
      return "This session's process has ended. The row is all that is left of it.";
    case "interrupted":
      return "The daemon restarted while an agent was working here. A plain shell holds its place.";
    default:
      return null;
  }
}

/// The workspace whose root contains this session, by longest match.
///
/// A session's `workspacePath` is the directory it was created in, not a
/// workspace id -- the daemon has never been told about workspaces -- so
/// this is a containment question. Longest wins because a worktree
/// registered as its own workspace sits inside another one's root, and
/// the nearer answer is the useful one.
function owningWorkspace(workspaces: Workspace[], s: ManagedSession): Workspace | null {
  let best: Workspace | null = null;
  for (const ws of workspaces) {
    const root = ws.rootPath;
    if (!root) continue;
    if (s.workspacePath !== root && !s.workspacePath.startsWith(`${root}/`)) continue;
    if (!best || root.length > (best.rootPath?.length ?? 0)) best = ws;
  }
  return best;
}

/// How far up the list a row sits. Deliberately built only from things
/// that do not change between polls: sorting on CPU would make rows swap
/// places under the pointer every couple of seconds, in a panel whose
/// buttons kill processes.
const STALE_RANK: Record<Staleness, number> = { orphaned: 0, exited: 1, interrupted: 2 };

function rank(row: SessionRow): number {
  if (row.staleness) return STALE_RANK[row.staleness];
  // A session nobody can see comes before one already on screen: the
  // visible ones have a tab of their own to be managed from.
  return row.visible ? 5 : 4;
}

export function sessionRows(args: {
  sample: ManagedSessions;
  /// The poll before this one, for the CPU rate. Null on the first.
  previous: ManagedSessions | null;
  workspaces: Workspace[];
  sessionNames: Record<string, string>;
}): SessionRow[] {
  const { sample, previous, workspaces, sessionNames } = args;
  const before = new Map((previous?.sessions ?? []).map((s) => [s.id, s]));
  const state = { workspaces, activeWorkspaceId: null };

  const rows = sample.sessions.map((s): SessionRow => {
    const at = findSessionLocation(state, s.id);
    const inPages = at ? workspaces.find((w) => w.id === at.workspaceId) ?? null : null;
    // The main agent session lives outside every page tree (D12), so the
    // layout search above can never find it. Reporting it as an
    // invisible session would be wrong in the one direction that
    // matters: it is on screen, on the Home tab.
    const asMain = at ? null : workspaces.find((w) => w.mainSessionId === s.id) ?? null;
    const owner = inPages ?? asMain ?? owningWorkspace(workspaces, s);
    const tone = staleness(s);
    const measured = sample.metrics && s.processCount > 0;

    return {
      id: s.id,
      label: sessionNames[s.id]?.trim() || s.command?.trim() || "shell",
      command: s.command,
      cwd: s.cwd,
      status: s.status,
      workspaceName: owner?.name ?? null,
      where: at
        ? inPages?.pages.find((p) => p.id === at.pageId)?.name ?? null
        : asMain
          ? "Home"
          : null,
      visible: Boolean(at || asMain),
      staleness: tone,
      stale: tone !== null,
      note: note(s, tone),
      cpuPercent: sample.metrics ? cpuShare(s, before.get(s.id) ?? null) : null,
      memBytes: measured ? s.rssBytes : null,
      processCount: s.processCount,
      pid: s.pid,
      orphan: s.orphan,
    };
  });

  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.workspaceName ?? "").localeCompare(b.workspaceName ?? "") ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id)
  );
}

/// What ending a row actually does.
///
/// Both, in this order, whenever a survivor is recorded: the orphan is
/// recorded ON the session's registry row, and killing the session
/// deletes that row -- so the other order would leave a live process
/// with nothing left that knows how to end it.
///
/// `killSession` is true even for a row with nothing running, because
/// there the row IS the thing left: it is what keeps an ended session in
/// this list, and clearing it is the only thing the button can mean.
export function killPlan(row: SessionRow): { endOrphan: boolean; killSession: boolean } {
  return { endOrphan: row.orphan !== null, killSession: true };
}

/// What one kill press asks first.
///
/// It names the session and the folder rather than describing the
/// category, because the rows in this panel look alike and the ones
/// worth killing are the ones nothing else is showing -- so the prompt is
/// the only place the human can check they picked the right one.
export function killConfirm(row: SessionRow): string {
  const where = row.workspaceName ? `${row.workspaceName} — ${row.cwd}` : row.cwd;
  const lines = [`End “${row.label}”?`, "", `In ${where}.`];
  if (row.orphan) {
    lines.push(
      "",
      `This also ends ${describeOrphan(row.orphan)}, the process that outlived the daemon ` +
        `and is still running there.`
    );
  }
  lines.push(
    "",
    "Anything it has already written to disk stays, and nothing it did is undone."
  );
  return lines.join("\n");
}

/// What a kill-all press asks, or null when there is nothing to end.
///
/// The stale count is called out separately because it is the reason
/// someone opens this panel and the reason the button is dangerous: the
/// rows nothing is showing are exactly the ones whose loss is hardest to
/// notice afterwards.
export function killAllConfirm(rows: SessionRow[]): string | null {
  if (rows.length === 0) return null;
  const stale = rows.filter((r) => r.stale).length;
  const orphans = rows.filter((r) => r.orphan).length;
  const lines = [
    `End all ${rows.length} ${rows.length === 1 ? "session" : "sessions"}?`,
    "",
    "Every terminal in every workspace closes, and every agent running in one stops.",
  ];
  if (stale > 0) {
    lines.push(
      "",
      `${stale} of them ${stale === 1 ? "is" : "are"} already stale` +
        (orphans > 0
          ? `, and ${orphans} ${orphans === 1 ? "has a process" : "have processes"} still running outside gavin.`
          : ".")
    );
  }
  lines.push("", "Anything they have written to disk stays, and nothing they did is undone.");
  return lines.join("\n");
}

/// The one-line count under the sidebar's Task manager row.
///
/// Only the parts that are non-zero: a strip that always reads
/// "· 0 hidden · 0 stale" trains the eye to skip it, and the two numbers
/// it carries are the only reason to open the panel at all.
export function managerSummary(rows: SessionRow[]): string {
  if (rows.length === 0) return "no sessions";
  const parts = [`${rows.length} ${rows.length === 1 ? "session" : "sessions"}`];
  const hidden = rows.filter((r) => !r.visible).length;
  const stale = rows.filter((r) => r.stale).length;
  if (hidden > 0) parts.push(`${hidden} hidden`);
  if (stale > 0) parts.push(`${stale} stale`);
  return parts.join(" · ");
}

const UNITS = [
  { limit: 1024 ** 3, suffix: "GB", decimals: 1 },
  { limit: 1024 ** 2, suffix: "MB", decimals: 0 },
] as const;

/// Memory at a size a human reads. Never bytes: the smallest thing in
/// this list is a shell at a few megabytes, and a nine-digit number in a
/// narrow column is unreadable.
///
/// An em dash for null, which is "nothing was measured" and must not
/// look like a measured zero.
export function formatMemory(bytes: number | null): string {
  if (bytes === null) return "—";
  for (const { limit, suffix, decimals } of UNITS) {
    if (bytes >= limit) return `${(bytes / limit).toFixed(decimals)} ${suffix}`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

/// One decimal, and no ceiling: a tree spread over four cores really is
/// 400%, and clamping it to 100 would hide the case the panel exists to
/// find.
export function formatCpu(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(1)}%`;
}
