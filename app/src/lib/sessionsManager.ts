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

import type { AlertOptions, ConfirmOptions } from "./dialog";
import { restartStopsAgentsLine, type DaemonCompat } from "./daemonCompat";
import { describeOrphan, type OrphanProcess } from "./orphan";

/// dialog.ts lets a prompt omit its lines; every prompt here has some,
/// and saying so in the type is what lets a test read them.
export type KillPrompt = ConfirmOptions & { lines: string[] };
export type KillAlert = AlertOptions & { lines: string[] };
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

/// The one word in the State column. Staleness first, because a stale
/// row is the reason the panel exists; then whether anything is showing
/// it; then what the daemon says it is doing. A hidden session that is
/// working reads "hidden" rather than "active" on purpose -- the fact
/// that nobody can see it is the fact that matters about it.
export type SessionState =
  | Staleness
  | "hidden"
  | "failed"
  | "waiting"
  | "active"
  | "idle"
  | "unknown";

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
  state: SessionState;
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

function stateOf(status: string, tone: Staleness | null, visible: boolean): SessionState {
  if (tone) return tone;
  if (!visible) return "hidden";
  switch (status) {
    case "working":
      return "active";
    case "waiting_for_input":
      return "waiting";
    case "idle":
    case "failed":
      return status;
    default:
      return "unknown";
  }
}

/// How far up the list a state sits under the default order: the rows
/// that need attention first, then the ones nobody can see (the visible
/// ones have a tab of their own to be managed from), then the rest by
/// how much they are asking of the human.
const STATE_RANK: Record<SessionState, number> = {
  orphaned: 0,
  exited: 1,
  interrupted: 2,
  hidden: 3,
  failed: 4,
  waiting: 5,
  active: 6,
  idle: 7,
  unknown: 8,
};

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
      state: stateOf(s.status, tone, Boolean(at || asMain)),
      note: note(s, tone),
      cpuPercent: sample.metrics ? cpuShare(s, before.get(s.id) ?? null) : null,
      memBytes: measured ? s.rssBytes : null,
      processCount: s.processCount,
      pid: s.pid,
      orphan: s.orphan,
    };
  });

  return sortRows(rows, DEFAULT_SORT);
}

export type SortKey = "name" | "state" | "mem";
export type SortDirection = "asc" | "desc";
export interface SortOrder {
  key: SortKey;
  dir: SortDirection;
}

/// State, attention first: what the list has always opened on. The
/// default is deliberately built only from things that do not change
/// between polls. Memory is offered because the card asked for it, but
/// it is a choice the human makes, not the order they are handed --
/// rows that swap places under the pointer every two seconds, in a
/// panel whose buttons kill processes, must be something they opted
/// into.
export const DEFAULT_SORT: SortOrder = { key: "state", dir: "asc" };

/// What a click on a column heading does to the order: the same column
/// flips, a new one starts ascending -- except memory, which starts
/// with the biggest, because nobody sorts by memory to find the
/// smallest shell.
export function nextSort(current: SortOrder, key: SortKey): SortOrder {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "mem" ? "desc" : "asc" };
}

/// The tie-break chain under every key, always ascending: same
/// workspace together, then by name, then by id so two unnamed shells
/// keep a fixed order between polls.
function byIdentity(a: SessionRow, b: SessionRow): number {
  return (
    (a.workspaceName ?? "").localeCompare(b.workspaceName ?? "") ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id)
  );
}

function primary(key: SortKey): (a: SessionRow, b: SessionRow) => number {
  switch (key) {
    case "name":
      return (a, b) => a.label.localeCompare(b.label);
    case "state":
      return (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state];
    case "mem":
      // Nulls are handled outside this comparison so they stay last in
      // BOTH directions: "nothing measured" is not the smallest figure.
      return (a, b) => (a.memBytes ?? 0) - (b.memBytes ?? 0);
  }
}

/// A new array in the asked-for order. Only the column itself reverses
/// under "desc"; the tie-break chain stays ascending so that rows equal
/// on the sorted column are always in the same, readable order.
export function sortRows(rows: SessionRow[], order: SortOrder): SessionRow[] {
  const compare = primary(order.key);
  const sign = order.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (order.key === "mem") {
      const aNone = a.memBytes === null;
      const bNone = b.memBytes === null;
      if (aNone !== bNone) return aNone ? 1 : -1;
    }
    return sign * compare(a, b) || byIdentity(a, b);
  });
}

/// Which rows the human has picked, and the one a shift click measures
/// its range from. Ids rather than rows: the rows are rebuilt every
/// poll, and the selection has to survive that.
export interface Selection {
  ids: string[];
  anchor: string | null;
}

export const NO_SELECTION: Selection = { ids: [], anchor: null };

/// The platform's list-selection grammar, as a reducer: a plain click
/// picks one row (and a second plain click on the only picked row lets
/// go of it, because a modal has no empty space to click on); the
/// command key toggles a row; shift takes the range from the anchor to
/// the clicked row, and with the command key held too, adds that range
/// to what is already picked.
///
/// `ordered` is the list AS DISPLAYED, so a range under a memory sort
/// is the rows the human can see between the two clicks, not the rows
/// the default order would put there.
export function selectRow(
  current: Selection,
  ordered: string[],
  id: string,
  mods: { shift: boolean; cmd: boolean }
): Selection {
  if (mods.shift) {
    const from = current.anchor !== null && ordered.includes(current.anchor) ? current.anchor : id;
    const a = ordered.indexOf(from);
    const b = ordered.indexOf(id);
    if (a < 0 || b < 0) return { ids: [id], anchor: id };
    const range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
    if (!mods.cmd) return { ids: range, anchor: from };
    const merged = new Set(current.ids);
    for (const x of range) merged.add(x);
    return { ids: [...merged], anchor: from };
  }
  if (mods.cmd) {
    if (current.ids.includes(id)) {
      return {
        ids: current.ids.filter((x) => x !== id),
        anchor: current.anchor === id ? null : current.anchor,
      };
    }
    return { ids: [...current.ids, id], anchor: id };
  }
  if (current.ids.length === 1 && current.ids[0] === id) return NO_SELECTION;
  return { ids: [id], anchor: id };
}

/// The picked rows, in display order, with any id the latest poll no
/// longer has silently dropped -- a killed row must not stay counted in
/// "Kill 3 selected".
export function selectedRows(rows: SessionRow[], selection: Selection): SessionRow[] {
  const picked = new Set(selection.ids);
  return rows.filter((r) => picked.has(r.id));
}

/// The footer's one line on how to pick rows, in the platform's own
/// keys -- the same place and voice as the card composer's hint.
export function selectionHint(isMac: boolean): string {
  return isMac
    ? "Click selects · ⇧Click extends · ⌘Click toggles · Click a heading to sort"
    : "Click selects · Shift+Click extends · Ctrl+Click toggles · Click a heading to sort";
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

const DISK_STAYS = "Anything already written to disk stays, and nothing that was done is undone.";

/// What one kill press asks first.
///
/// It names the session and the folder rather than describing the
/// category, because the rows in this panel look alike and the ones
/// worth killing are the ones nothing else is showing -- so the prompt is
/// the only place the human can check they picked the right one.
///
/// `danger`, always: ConfirmPrompt keeps focus on the dismissing button
/// for a danger choice, so Enter cannot fire a kill by reflex.
export function killConfirm(row: SessionRow): KillPrompt {
  const where = row.workspaceName ? `${row.workspaceName} — ${row.cwd}` : row.cwd;
  const lines = [`In ${where}.`];
  if (row.orphan) {
    lines.push(
      `This also ends ${describeOrphan(row.orphan)}, the process that outlived the daemon ` +
        `and is still running there.`
    );
  }
  lines.push(DISK_STAYS);
  return { title: `End “${row.label}”?`, lines, confirmLabel: "End session", danger: true };
}

/// Which button a batch came from. The rows are already the batch --
/// the caller has filtered them -- and the scope only decides how the
/// prompt talks about them.
export type KillScope = "all" | "stale" | "selected";

const NAMES_SHOWN = 6;

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/// The line that separates the stale rows from the rest of a batch, or
/// null when there are none. Called out because it is the reason
/// someone opens this panel and the reason the button is dangerous: the
/// rows nothing is showing are exactly the ones whose loss is hardest to
/// notice afterwards.
function staleLine(rows: SessionRow[]): string | null {
  const stale = rows.filter((r) => r.stale).length;
  if (stale === 0) return null;
  const orphans = rows.filter((r) => r.orphan).length;
  return (
    `${stale} of them ${stale === 1 ? "is" : "are"} already stale` +
    (orphans > 0
      ? `, and ${orphans} ${orphans === 1 ? "has a process" : "have processes"} still running outside gavin.`
      : ".")
  );
}

/// What a batch is costing, or null when nothing in it was measured.
///
/// The one figure the grid cannot show: every other number in this
/// prompt can be checked against the rows behind it, but a sum over a
/// selection appears nowhere else -- and "these three are holding 4 GB"
/// is the reason someone reaches for the button in the first place.
function costLine(rows: SessionRow[]): string | null {
  const total = totalUsage(rows);
  const parts: string[] = [];
  if (total.memBytes !== null) parts.push(`${formatMemory(total.memBytes)} of memory`);
  if (total.cpuPercent !== null) parts.push(`${formatCpu(total.cpuPercent)} of one core`);
  if (parts.length === 0) return null;
  return `Together they are using ${parts.join(" and ")}.`;
}

/// What a batch press asks, or null when there is nothing to end.
///
/// One prompt for the batch, matching how every other batch close in the
/// app behaves: a prompt per session would train the human to click
/// through prompts, which is worse than the single honest one that names
/// the count. A batch of one is asked about as that one row, so the
/// prompt names it instead of saying "1 session".
///
/// The stale scope spells out what clearing each kind does, because the
/// kinds are not alike: clearing an exited row deletes a record, and
/// clearing an orphan sends SIGTERM to a live process.
export function killBatchConfirm(rows: SessionRow[], scope: KillScope): KillPrompt | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return killConfirm(rows[0]);
  const n = rows.length;

  if (scope === "stale") {
    const kinds: Array<[Staleness, string]> = [
      ["exited", "only the row is left, and clearing it removes the record"],
      ["interrupted", "a plain shell holding a run's place closes"],
      ["orphaned", "a process still running outside gavin is sent SIGTERM"],
    ];
    const lines: string[] = [];
    for (const [kind, what] of kinds) {
      const count = rows.filter((r) => r.staleness === kind).length;
      if (count > 0) lines.push(`${count} ${kind}: ${what}.`);
    }
    const cost = costLine(rows);
    if (cost) lines.push(cost);
    lines.push(DISK_STAYS);
    return { title: `Clear ${n} stale sessions?`, lines, confirmLabel: "Clear stale", danger: true };
  }

  const lines: string[] = [];
  if (scope === "all") {
    lines.push("Every terminal in every workspace closes, and every agent running in one stops.");
  } else {
    const names = rows.slice(0, NAMES_SHOWN).map((r) => `“${r.label}”`);
    const more = n - names.length;
    lines.push(names.join(", ") + (more > 0 ? ` and ${more} more` : "") + ".");
  }
  const stale = staleLine(rows);
  if (stale) lines.push(stale);
  const cost = costLine(rows);
  if (cost) lines.push(cost);
  lines.push(DISK_STAYS);
  return scope === "all"
    ? { title: `End all ${plural(n, "session")}?`, lines, confirmLabel: "End all", danger: true }
    : { title: `End ${n} selected sessions?`, lines, confirmLabel: "End selected", danger: true };
}

/// What the task manager's Restart-daemon press asks first.
///
/// The panel offers the restart because it is the one screen that can
/// see the whole cost of it: every session the daemon is holding, the
/// hidden ones included, is on this list. So the prompt counts THAT list
/// rather than repeating Settings' abstract "every terminal session" --
/// a number the human can check against the rows behind the dialog is
/// the only way they can tell a quiet restart from an expensive one.
///
/// The version-dependent sentence about running agents is
/// `restartStopsAgentsLine`, shared with the Settings prompt: on a
/// pre-v20 daemon a restart RE-RUNS every agent command instead of
/// stopping it, and that warning must not exist in two places that can
/// drift apart.
///
/// The orphan line is this panel's alone, and it is the one thing a
/// restart is NOT: `SessionManager::recover` re-probes a recorded
/// survivor and keeps it when it is still alive, so restarting does not
/// end the processes that already outlived a daemon -- it hands them to
/// the next one. Someone reaching for Restart to be rid of them would be
/// choosing the one action that cannot do it.
///
/// `danger`, always, and for the same reason every kill here is:
/// ConfirmPrompt keeps focus on the dismissing button for a danger
/// choice, so Enter cannot restart the daemon by reflex.
export function restartConfirm(rows: SessionRow[], compat: DaemonCompat | null): KillPrompt {
  const hidden = rows.filter((r) => !r.visible).length;
  const orphans = rows.filter((r) => r.orphan).length;
  const lines: string[] = [];

  if (rows.length === 0) {
    lines.push("There are no sessions to lose — the daemon simply goes away and comes back.");
  } else {
    const where = hidden > 0 ? `, including the ${plural(hidden, "session")} no tab is showing` : "";
    lines.push(
      `All ${plural(rows.length, "session")} in this list${where} restart as fresh shells at ` +
        `their current folders.`
    );
  }
  lines.push(restartStopsAgentsLine(compat));
  if (orphans > 0) {
    lines.push(
      `This does not end the ${plural(orphans, "process")} still running outside gavin: the new ` +
        `daemon re-checks each one and keeps the ones that are still alive. End those from this ` +
        `list instead.`
    );
  }
  lines.push("Scrollback in open terminals is lost.");
  lines.push("The window stays open — plans, boards and git keep working.");

  return {
    title: "Restart gavin-daemon?",
    lines,
    confirmLabel: "Restart daemon",
    danger: true,
  };
}

/// The restart never completed: the old daemon would not die, or the new
/// one would not answer the version probe.
///
/// Loud rather than silent because the app is now in the one state this
/// panel cannot describe -- it is showing a list it read from a daemon
/// that may no longer be there.
export function restartFailedAlert(error: unknown): KillAlert {
  return {
    title: "Couldn’t restart the daemon",
    lines: [
      error instanceof Error ? error.message : String(error),
      "Sessions may already be gone. Close this and reopen it to see what the daemon is holding now.",
    ],
  };
}

/// The restart worked and achieved nothing: the daemon came back still
/// older than this app. `restartOutcome` writes the sentence; this only
/// puts it somewhere the human will read it, because in this panel there
/// is no banner underneath the button to render it into.
export function restartOutcomeAlert(note: string): KillAlert {
  return { title: "Restarted, still an older daemon", lines: [note] };
}

/// The daemon refused, or the request never got there.
export function killFailedAlert(row: SessionRow, error: unknown): KillAlert {
  return {
    title: `Couldn’t end “${row.label}”`,
    lines: [error instanceof Error ? error.message : String(error)],
  };
}

/// The survivor was asked to stop and did not. The row stays because it
/// is where the pid is recorded, and the alert hands that pid over.
export function refusedOrphanAlert(row: SessionRow): KillAlert {
  const what = row.orphan ? describeOrphan(row.orphan) : row.label;
  return {
    title: `“${row.label}” is still running`,
    lines: [
      `${what} was asked to stop and ignored SIGTERM, which is how it survived the daemon in the first place.`,
      `The session is left in place so you keep the pid: end it from Activity Monitor, or with ` +
        `\`kill -9 ${row.orphan?.pid ?? row.pid}\`.`,
    ],
  };
}

/// One report at the end of a batch, rather than a modal between every
/// pair of sessions.
export function survivorsAlert(survived: string[], total: number): KillAlert {
  return {
    title: `${survived.length} of ${total} could not be ended`,
    lines: [
      survived.join(", "),
      "A process that ignores SIGTERM is the usual reason — those are still listed, with the pid to end from Activity Monitor.",
    ],
  };
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

/// What the whole list is costing, as one line under it.
///
/// Summed from the ROWS rather than from the sample, so the totals cover
/// exactly what the human can see -- and so a figure this module already
/// refused to state (`cpuPercent` null, because the pair of samples
/// could not honestly produce a rate) is left out of the sum for the
/// same reason it renders as an em dash in its own cell. A total that
/// quietly counted those as zero would be the one lie the per-row
/// arithmetic was written to avoid, told once more at the bottom of the
/// table.
export interface Totals {
  sessions: number;
  /// Processes behind the two figures, across every session's tree.
  processes: number;
  /// The rated shares of one core, added up: 200 is two cores' worth.
  /// Null when NO row has a rate -- the first poll, or a daemon too old
  /// to measure -- which has to read as "nothing measured", never 0.0%.
  cpuPercent: number | null;
  /// Resident bytes added up, null on the same terms.
  memBytes: number | null;
  /// Rows with something running whose CPU could not be rated. The total
  /// is a floor by exactly these, and saying how many is what lets a
  /// human tell a quiet fleet from a freshly opened panel.
  cpuPending: number;
}

export function totalUsage(rows: SessionRow[]): Totals {
  let cpu = 0;
  let rated = 0;
  let mem = 0;
  let measured = 0;
  let processes = 0;
  let cpuPending = 0;

  for (const row of rows) {
    processes += row.processCount;
    if (row.cpuPercent !== null) {
      cpu += row.cpuPercent;
      rated += 1;
    } else if (row.processCount > 0) {
      // Nothing running is not a gap: an exited row contributes no CPU
      // because there is none, not because nobody could measure it.
      cpuPending += 1;
    }
    if (row.memBytes !== null) {
      mem += row.memBytes;
      measured += 1;
    }
  }

  return {
    sessions: rows.length,
    processes,
    cpuPercent: rated > 0 ? cpu : null,
    memBytes: measured > 0 ? mem : null,
    cpuPending,
  };
}

/// What the totals line says it covers.
///
/// Counts rather than a bare "Total", because the two figures beside it
/// are sums over a list that changes every two seconds: without knowing
/// how many things went into a number, a human cannot tell a fleet that
/// grew from one that got busier.
export function totalsCoverage(total: Totals): string {
  const parts = [
    plural(total.sessions, "session"),
    plural(total.processes, "process", "processes"),
  ];
  if (total.cpuPending > 0) parts.push(`${total.cpuPending} not rated yet`);
  return parts.join(" · ");
}

/// The caveats behind the two sums, for the hover.
///
/// Both are honest as a direction and neither is a machine reading, and
/// the panel has to say which is which somewhere: CPU adds shares of ONE
/// core, so its ceiling is the core count rather than 100; memory adds
/// resident sizes, and a page shared between two processes is resident
/// in both. The per-session figure the daemon reports already sums a
/// tree that way (proc.rs, tree_usage), so this total is the same kind
/// of number one level up -- an upper bound, not what ending everything
/// would hand back.
export function totalsNote(total: Totals): string {
  const lines = [
    "CPU adds each session’s share of one core, so 200% is two cores’ worth of work.",
    "Memory adds resident sizes, so a page shared between processes is counted in each — an upper bound, not what ending them would give back.",
  ];
  if (total.cpuPending > 0) {
    lines.push(
      `${plural(total.cpuPending, "session")} started too recently to have a rate, so the CPU ` +
        `figure is at least this much.`
    );
  }
  return lines.join("\n");
}
