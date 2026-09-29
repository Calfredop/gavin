// What Headroom saved inside each agent's current limit window: the hub's
// economics beside the usage it is meant to stretch
// (`2026-09-28-headroom-design.md`, "Savings").
//
// A fold over snapshots the daemon already took. When a compressed
// session ends, the daemon writes what Headroom saved it onto its card
// runs (v49), and the hub asks for every snapshot since the earliest
// window it shows. Nothing here reads Headroom: its own per-session map is
// capped and evicts, so Gavin's snapshots are the record.
//
// Two rules decide every sum here.
//
// **A run is placed at its end.** The snapshot is taken when the session
// ends, so that is the only moment the saving is known in full. A run
// that started in the last window and ended in this one counts here --
// the same rule for every run, rather than an apportioning nobody could
// check.
//
// **A window whose start is unknown has no sum.** A window is its reset
// minus its length, and the length is known only for the rolling windows
// gavin recognises. A spend limit is billed over a month whose start
// gavin cannot see; guessing one would sum savings from outside it.

import type { UsageWindow } from "$lib/agents/agentUsage";
import { LONG_WINDOW, SHORT_WINDOW } from "$lib/agents/usageProjection";
import { formatTokens } from "$lib/cards/runHistory";

/// Mirrors `RunSavings` in the protocol crate. Epoch SECONDS.
export interface RunSavings {
  workspaceId: string;
  path: string;
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  tokensSaved: number;
  requests: number;
}

/// One window's sum. `runs` counts sessions, so a run bound to two cards
/// is one.
export interface WindowSavings {
  tokens: number;
  requests: number;
  runs: number;
}

/// The rolling windows whose length is known: Anthropic's by name,
/// codex's by rank. The lengths are the usage projection's own, so the
/// two surfaces can never disagree about where a window began.
const SPAN_SECONDS: Record<string, number> = {
  five_hour: SHORT_WINDOW.spanMs / 1000,
  primary: SHORT_WINDOW.spanMs / 1000,
  seven_day: LONG_WINDOW.spanMs / 1000,
  secondary: LONG_WINDOW.spanMs / 1000,
};

/// Where a window began, in epoch seconds: its reset minus its length.
/// Null when either is unknown.
export function windowStart(window: UsageWindow): number | null {
  const span = SPAN_SECONDS[window.id];
  if (span === undefined || window.resetsAt === null) return null;
  return window.resetsAt - span;
}

/// What Headroom saved inside `window`, over the runs of the workspaces
/// that launch this agent. An empty sum when nothing ended in the window;
/// null when the window's start is unknown.
export function savedInWindow(
  runs: RunSavings[],
  window: UsageWindow,
  workspaceIds: ReadonlySet<string>
): WindowSavings | null {
  const start = windowStart(window);
  if (start === null) return null;
  const bySession = new Map<string, RunSavings>();
  for (const run of runs) {
    if (!workspaceIds.has(run.workspaceId)) continue;
    if (run.endedAt === null || run.endedAt < start) continue;
    bySession.set(run.sessionId, run);
  }
  let tokens = 0;
  let requests = 0;
  for (const run of bySession.values()) {
    tokens += run.tokensSaved;
    requests += run.requests;
  }
  return { tokens, requests, runs: bySession.size };
}

/// The few characters a usage row has room for: "saved 341k". Null when
/// no compressed run ended in the window, so a workspace that never
/// turned compression on grows no "saved 0" on its row.
export function windowSavingsLine(savings: WindowSavings | null): string | null {
  if (!savings || savings.runs === 0) return null;
  return `saved ${formatTokens(savings.tokens)}`;
}

/// The exact figures and what they cover, for the line's tooltip.
export function windowSavingsTip(savings: WindowSavings, window: UsageWindow): string {
  const n = (count: number, one: string, many: string) =>
    `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
  return (
    `Headroom saved ${n(savings.tokens, "token", "tokens")} over ${n(savings.requests, "request", "requests")}, ` +
    `in ${n(savings.runs, "card run", "card runs")} that ended in this ${window.label} window`
  );
}

/// How far back the hub has to ask: the earliest start among the windows
/// it shows. Null when none has a known start, and then it asks nothing.
export function savingsSince(windows: Array<UsageWindow | null>): number | null {
  let earliest: number | null = null;
  for (const window of windows) {
    const start = window ? windowStart(window) : null;
    if (start !== null && (earliest === null || start < earliest)) earliest = start;
  }
  return earliest;
}

/// Each usage row's saving, in the window the row shows.
///
/// A run's agent is the one its WORKSPACE launches, the attribution run
/// history already makes for a run's cost: a run does not record which
/// profile launched it. Null for a row with no window, and for every row
/// while the snapshots are still unread (`runs` null) -- "not read yet"
/// is not "saved nothing".
export function savingsByProfile(
  rows: Array<{ profileId: string; worst: UsageWindow | null }>,
  profileByWorkspace: Record<string, string | null>,
  runs: RunSavings[] | null
): Record<string, WindowSavings | null> {
  const workspaces = new Map<string, Set<string>>();
  for (const [workspaceId, profileId] of Object.entries(profileByWorkspace)) {
    if (!profileId) continue;
    let set = workspaces.get(profileId);
    if (!set) workspaces.set(profileId, (set = new Set()));
    set.add(workspaceId);
  }
  const out: Record<string, WindowSavings | null> = {};
  for (const row of rows) {
    out[row.profileId] =
      runs && row.worst ? savedInWindow(runs, row.worst, workspaces.get(row.profileId) ?? new Set()) : null;
  }
  return out;
}
