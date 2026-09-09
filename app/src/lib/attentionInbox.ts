// The attention inbox: every session in the fleet that is waiting on a
// HUMAN, longest wait first.
//
// A sibling of appHub.ts's running-tasks column and built the same way --
// one pure walk over stores the app already keeps filled, so the hub
// introduces no polling and this list can never disagree with the column
// beside it. Nothing here fetches, and nothing here is stored.
//
// The difference between the two is which question they answer. The
// running column asks "what is moving", and lists a card for every live
// agent behind one. This asks "what has stopped and is waiting for me",
// which is a smaller set with a sharper claim: a session is in it only
// when somebody has to come and look.
//
// Three reasons put a session here, and they are the app's existing
// vocabulary rather than a new one (StepAttention, from the rails):
//
//   asking       the agent has a question on screen
//   failed       the agent stopped because something BROKE
//   turn-ended   a rail step's agent stopped talking and its card never
//                reached the done column
//   stale        the same, ten minutes on: nothing is coming
//   decoy-edit   a rail step's agent wrote its worktree's own copy of the
//                card, so the board can never see the work
//
// The first two are read straight off the session's status, so they hold
// for a terminal nobody filed a card for. The last three can only be
// said by a rail -- an idle agent with no rail behind it is a shell at
// its prompt, which is not the same thing as work that stopped short,
// and only a rail knows which checkout its agent was launched in.

import { cardIndex, type Orchestration, type StepAttention } from "$lib/orchestration/orchestration";
import { sessionLabel } from "$lib/paths";
import { PHASE_LABEL } from "$lib/hub/appHub";
import type { PageTabState } from "$lib/sidebar/sidebarSummary";
import type { LayoutNode } from "$lib/panes/layout";
import type { Workspace, WorkspacesData } from "$lib/workspace";
import type { Board } from "$lib/board/kanban";
import type { GavinTree } from "$lib/gavin";

/// Why a row is in the inbox. The rails' own answers, reused rather than
/// re-spelled: a running step marked `asking` and a bare terminal
/// waiting for input are one fact, and the app has exactly one word for
/// it.
///
/// `review` is the one mark that cannot reach this list, and the type
/// says so rather than leaving a label nothing can draw. Every row here
/// IS a session -- that is what the list is -- and a `review` step has
/// none: gavin launches nothing for it and waits on the person instead.
/// The rail, its chip and the hub's attention pip all show that wait;
/// this list is about sessions, and a rail gate is not one.
///
/// `unreviewed` is out for exactly the same reason and one step further:
/// that step never launched at all, so there is not even a session to
/// have gone quiet. It shows where a rail gate shows -- the step's chip,
/// the rail header, the sidebar recap and the hub's attention count.
export type AttentionReason = Exclude<StepAttention, "review" | "unreviewed">;

/// When a session entered the status it currently holds.
///
/// `watched` is the honest half. The daemon does not report when a
/// status BEGAN -- only that it changed -- so gavin can time a wait only
/// from the transition it saw. A status already in place when the app
/// attached (every session, after a relaunch) is stamped at the moment
/// it was first seen, and `watched: false` says so: the duration built
/// from it is a lower bound, never a measurement.
export interface StatusSince {
  /// Epoch milliseconds.
  at: number;
  /// True when THIS app run watched the transition happen.
  watched: boolean;
}

/// The slice of LayoutState this file reads, structurally -- the same
/// shape appHub's FleetState takes, and for the same reason: the pure
/// functions have to be drivable from a fixture without building a store.
export type AttentionState = WorkspacesData &
  PageTabState & {
    interruptedSessionIds: ReadonlySet<string>;
    sessionNames: Record<string, string>;
    cwdBySessionId: Record<string, string>;
    failureReasonById: Record<string, string>;
    statusSinceById: Record<string, StatusSince>;
  };

export interface AttentionInboxInput {
  state: AttentionState;
  boards: Record<string, Board | undefined>;
  trees: Record<string, GavinTree | undefined>;
  orchestrations: Record<string, Orchestration | undefined>;
  /// Per workspace, the marks stepAttentions() produced for that
  /// workspace's running steps, by step id. Absent reads as "no rail has
  /// anything to say", which is also what a workspace whose
  /// orchestration has not loaded looks like.
  stepAttentions?: Record<string, ReadonlyMap<string, StepAttention>>;
}

/// One session waiting on a human.
export interface AttentionRow {
  sessionId: string;
  /// The workspace whose page holds the TAB -- not necessarily the one
  /// the card is filed in, because a tab can be dragged across
  /// workspaces and the click has to follow the tab.
  workspaceId: string;
  workspaceName: string;
  /// Null for a workspace's own Home agent panel, which lives outside
  /// every page tree. That null is what routes the click to the Home tab
  /// instead of to a terminal.
  pageId: string | null;
  pageName: string;
  /// What the tab calls itself: the human's name for it, else its
  /// folder, else a short id -- the tab bar's own chain.
  tabName: string;
  reason: AttentionReason;
  /// The card bound to this session, wherever it is filed, or null for a
  /// terminal nobody filed one for.
  cardTitle: string | null;
  cardPath: string | null;
  cardWorkspaceId: string | null;
  /// How long the session has been in this state, or null when gavin has
  /// no stamp for it at all. Floored at zero: a stamp in the future means
  /// a clock moved backwards, not a wait that has not started.
  waitedMs: number | null;
  /// False when `waitedMs` is measured from the moment gavin SAW the
  /// state rather than from the moment it began (see StatusSince).
  watched: boolean;
  /// The agent's own line about what broke, for a `failed` row.
  failureReason: string | null;
}

/// The word each reason goes by on screen.
///
/// Two of the three are the hub's own words for the same states, taken
/// from PHASE_LABEL rather than retyped: the inbox and the running
/// column sit on one page, and a session that reads "Waiting for you" in
/// one and "Needs input" in the other is two vocabularies for one fact.
export const REASON_LABEL: Record<AttentionReason, string> = {
  asking: PHASE_LABEL.waiting,
  failed: PHASE_LABEL.failed,
  "turn-ended": "Turn ended, card unmoved",
  // The aged form of the row above. The wait column already carries the
  // number, so the label carries the verdict instead of repeating it.
  stale: "Stopped for good, card unmoved",
  // Names the mistake, not the symptom: this row's fix is a file, and a
  // human reading "turn ended" would go and restart the agent into the
  // same wrong file.
  "decoy-edit": "Edited the worktree's copy of the card",
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/// The wait in a column's worth of characters: "just now", "5m", "3h",
/// "2d". Coarse on the same principle as the hub's relativeTime -- the
/// row answers "which of these has waited longest", not "how long
/// exactly".
///
/// An unwatched wait never claims to be a measurement. Under a minute it
/// says where it came from ("since launch"); above one it wears a "≥",
/// because the session may well have been waiting since yesterday and
/// gavin only met it this morning.
export function waitLabel(waitedMs: number | null, watched: boolean): string {
  if (waitedMs === null) return "—";
  const bound = watched ? "" : "≥";
  if (waitedMs < MINUTE) return watched ? "just now" : "since launch";
  if (waitedMs < HOUR) return `${bound}${Math.floor(waitedMs / MINUTE)}m`;
  if (waitedMs < DAY) return `${bound}${Math.floor(waitedMs / HOUR)}h`;
  return `${bound}${Math.floor(waitedMs / DAY)}d`;
}

/// The bubble on an inbox row: the reason and the wait, where the
/// session is, the card behind it, what broke, and which jump the click
/// makes. Here rather than in the template so the row, its tooltip and
/// its screen-reader name are one sentence rather than three.
export function rowTip(row: AttentionRow): string {
  const parts = [`${REASON_LABEL[row.reason]} · ${waitLabel(row.waitedMs, row.watched)}`];
  // The "≥" in the column is a mark, not a sentence -- this is where it
  // gets explained.
  if (!row.watched) {
    parts.push("already in this state when gavin attached, so the wait is a floor");
  }
  parts.push([row.workspaceName, row.pageName, row.tabName].join(" · "));
  if (row.cardTitle) parts.push(row.cardTitle);
  if (row.failureReason) parts.push(row.failureReason);
  // The Home agent panel lives outside every page tree, so its row lands
  // on the workspace's Home tab rather than on a terminal. Promising the
  // other jump would be the one thing a bubble must not do.
  parts.push(row.pageId === null ? "open the Home tab" : "open the session");
  return parts.join(" — ");
}

/// Every session in the fleet that is waiting on a human, longest first.
export function attentionInbox(input: AttentionInboxInput, now: number): AttentionRow[] {
  const bindings = cardBindings(input);
  const marks = sessionAttentionMarks(input);
  const rows: AttentionRow[] = [];
  const seen = new Set<string>();
  for (const ws of input.state.workspaces) {
    for (const location of sessionLocations(ws)) {
      if (seen.has(location.sessionId)) continue;
      const reason = reasonFor(input.state, location.sessionId, marks);
      if (!reason) continue;
      seen.add(location.sessionId);
      rows.push(row(input, ws, location, reason, bindings, now));
    }
  }
  // Longest wait first, which is the whole ordering the list promises.
  // A wait nobody measured sorts last rather than as a fresh one: an
  // unstamped session is the row this list knows least about, and giving
  // it the top would be the one place the order actively misleads.
  // Ties fall back to workspace then tab name, so two sessions stamped in
  // the same millisecond do not swap places as the fleet ticks.
  rows.sort(
    (a, b) =>
      (b.waitedMs ?? -1) - (a.waitedMs ?? -1) ||
      a.workspaceName.localeCompare(b.workspaceName) ||
      a.tabName.localeCompare(b.tabName) ||
      a.sessionId.localeCompare(b.sessionId)
  );
  return rows;
}

interface SessionLocation {
  sessionId: string;
  pageId: string | null;
  pageName: string;
}

/// Every session a workspace shows, with where it is shown. The main
/// agent panel comes last and carries no page: it lives outside every
/// page tree, on the workspace's Home tab.
function sessionLocations(ws: Workspace): SessionLocation[] {
  const out: SessionLocation[] = [];
  for (const page of ws.pages) {
    for (const sessionId of allTabIds(page.layout)) {
      out.push({ sessionId, pageId: page.id, pageName: page.name });
    }
  }
  if (ws.mainSessionId) {
    out.push({ sessionId: ws.mainSessionId, pageId: null, pageName: "Home" });
  }
  return out;
}

// A local walk rather than layout's allSessionIds, because every id has
// to come back with the page it was found on -- that is what a row says
// and what its click needs. The ids include file and board tabs, which
// stand for no agent at all; reasonFor drops those.
function allTabIds(node: LayoutNode): string[] {
  return node.type === "leaf" ? node.tabs : node.children.flatMap(allTabIds);
}

/// Why this session is waiting on a human, or null.
///
/// `interrupted` first, and for the reason the board's dot and the hub's
/// running column both check it first: the daemon's status for an
/// interrupted session describes the bare shell that replaced the agent,
/// so believing it would list a session with no agent in it.
///
/// Then `failed` over `asking` over a rail's mark, which is
/// ATTENTION_RANK's own order -- a broken agent is not a rail deciding a
/// turn ended.
function reasonFor(
  state: AttentionState,
  sessionId: string,
  marks: Map<string, StepAttention>
): AttentionReason | null {
  if (state.interruptedSessionIds.has(sessionId)) return null;
  if (state.fileTabsById[sessionId] || state.boardTabsById[sessionId] || state.cardTabsById[sessionId])
    return null;
  const status = state.sessionStatusById[sessionId];
  const mark = marks.get(sessionId);
  if (status === "failed") return "failed";
  // Before `asking`, and without consulting the status at all: the write
  // has already happened, so an agent still talking -- or still asking
  // about the card it cannot reach -- is no less stuck for it. This is
  // ATTENTION_RANK's order, kept in step with it deliberately.
  if (mark === "decoy-edit") return "decoy-edit";
  if (status === "waiting_for_input") return "asking";
  // Only a rail can say these, and only about an agent that has actually
  // gone quiet. An idle session with no mark is a shell at its prompt.
  if (status === "idle" && (mark === "turn-ended" || mark === "stale")) return mark;
  return null;
}

function row(
  input: AttentionInboxInput,
  ws: Workspace,
  location: SessionLocation,
  reason: AttentionReason,
  bindings: Map<string, CardBinding>,
  now: number
): AttentionRow {
  const { sessionId } = location;
  const state = input.state;
  const card = bindings.get(sessionId) ?? null;
  const stamp = state.statusSinceById[sessionId];
  return {
    sessionId,
    workspaceId: ws.id,
    workspaceName: ws.name,
    pageId: location.pageId,
    pageName: location.pageName,
    tabName: sessionLabel(state.sessionNames, state.cwdBySessionId, sessionId),
    reason,
    cardTitle: card?.title ?? null,
    cardPath: card?.path ?? null,
    cardWorkspaceId: card?.workspaceId ?? null,
    waitedMs: stamp ? Math.max(0, now - stamp.at) : null,
    watched: stamp?.watched ?? false,
    failureReason: reason === "failed" ? (state.failureReasonById[sessionId] ?? null) : null,
  };
}

interface CardBinding {
  workspaceId: string;
  path: string;
  title: string;
}

/// Session id to the card bound to it, across the WHOLE fleet.
///
/// Fleet-wide rather than per workspace because the two can differ: a
/// tab dragged into another workspace keeps the binding it was launched
/// with, and a row that only looked in its own workspace's board would
/// drop the card's name exactly when the human most needs it.
function cardBindings(input: AttentionInboxInput): Map<string, CardBinding> {
  const out = new Map<string, CardBinding>();
  for (const [workspaceId, board] of Object.entries(input.boards)) {
    const cards = cardIndex(input.trees[workspaceId]);
    for (const cs of board?.cardSessions ?? []) {
      if (out.has(cs.sessionId)) continue;
      const title = cards.get(cs.path)?.plan.title?.trim();
      out.set(cs.sessionId, {
        workspaceId,
        path: cs.path,
        // The file name is the fallback the tab bar's card link already
        // uses for a card the tree has not seen -- never a blank name.
        title: title || (cs.path.split("/").at(-1) ?? cs.path),
      });
    }
  }
  return out;
}

/// The rails' step marks, re-keyed by the SESSION each marked step is
/// running. Fleet-wide for the same reason the bindings are: a rail's
/// page can hold tabs a different workspace shows.
function sessionAttentionMarks(input: AttentionInboxInput): Map<string, StepAttention> {
  const out = new Map<string, StepAttention>();
  for (const [workspaceId, orch] of Object.entries(input.orchestrations)) {
    const marks = input.stepAttentions?.[workspaceId];
    if (!orch || !marks || marks.size === 0) continue;
    for (const run of orch.stepRuns) {
      const mark = marks.get(run.stepId);
      if (mark && run.sessionId) out.set(run.sessionId, mark);
    }
  }
  return out;
}
