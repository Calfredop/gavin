// A CARD as a follow-up: picked in the follow-up queue view instead of
// typed, and handed over one of two ways.
//
//  - inline: the card's run prompt is queued on THIS session like any
//    typed follow-up. The daemon owns that queue, so it is delivered at
//    the next idle (or at once when the agent is already idle) exactly as
//    a typed message is -- the card is an injected prompt, nothing more.
//  - new-session: the card is RUN, in a tab of its own, once this
//    session's turn ends. The daemon has no notion of "launch a card", so
//    this half is held by the app: per window, persisted the way the
//    launch queue is, and fired by watching the session's status.
//
// Everything here is pure: which cards may be picked, what to say about a
// held card, when it may fire, and the stored shape. The store and the
// watcher are cardFollowUpState.ts.

import type { GavinTree } from "$lib/core/gavin";
import type { WorkspacesData } from "$lib/core/workspace";
import { allSessionIds } from "$lib/panes/layout";
import { slugStatus } from "$lib/core/planBoard";
import { verdictIsAsking } from "$lib/agents/turnVerdict";
import { endsTurn } from "$lib/core/turnEnd";
import type { QueueTarget } from "$lib/agents/queuedInput";

/// How a picked card reaches the agent.
export type CardFollowUpMode = "inline" | "new-session";

/// A card waiting to be RUN in a new tab when `sessionId`'s turn ends.
///
/// `title` is a snapshot for the row, so a card renamed while it waits
/// still reads as the thing the human picked; the launch itself re-reads
/// the card from the tree by `cardPath`, so it runs the card as it is
/// THEN, never as it was when picked.
///
/// `error` is set when a launch was attempted and refused. Such an entry
/// is no longer fired automatically -- a gate that refused once (a
/// missing attachment, the develop lock) would refuse again on every
/// status change and repaint the same error forever -- and waits for the
/// human to open it by hand or cancel it.
export interface CardFollowUp {
  id: string;
  sessionId: string;
  workspaceId: string;
  cardPath: string;
  title: string;
  askedAtMs: number;
  error?: string | null;
}

/// The two modes as the picker offers them: a short label for the switch
/// and the sentence under it that says what will actually happen.
export const CARD_FOLLOW_UP_MODES: ReadonlyArray<{
  mode: CardFollowUpMode;
  label: string;
  note: string;
}> = [
  {
    mode: "inline",
    label: "Inline in this session",
    note: "The card's run prompt is queued here, so this agent picks it up in the same conversation when its turn ends.",
  },
  {
    mode: "new-session",
    label: "Open in a new session",
    note: "The card runs in a new tab with an agent of its own, once this agent's turn ends.",
  },
];

/// One pickable card, as the picker lists it.
export interface CardCandidate {
  path: string;
  title: string;
  kind: "task" | "plan";
  status: string | null;
  contextName: string;
}

/// The cards a human may pick as a follow-up, filtered by `query`.
///
/// Runnable cards only: notes are never runnable, and an archived or Done
/// card is finished work -- running it again from here would un-file it
/// as a side effect of a picker, which is not what a human scrolling a
/// list is asking for. The board's own Run is where a Done card is
/// deliberately re-opened.
///
/// Matching is every word of the query, in any order, against the title
/// and the file name -- the two things a human remembers a card by.
/// Tree order is kept rather than re-ranked, so the list does not jump
/// around as the query grows.
export function cardFollowUpCandidates(
  tree: GavinTree | undefined,
  query: string,
  limit = 12
): CardCandidate[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  const out: CardCandidate[] = [];
  for (const ctx of tree?.contexts ?? []) {
    for (const plan of ctx.plans) {
      if (plan.kind === "note") continue;
      if (plan.path.includes("/plans/archive/") || plan.path.includes("/plans/done/")) continue;
      if (plan.status !== null && slugStatus(plan.status) === "done") continue;
      const hay = `${plan.title} ${plan.fileName}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      out.push({
        path: plan.path,
        title: plan.title,
        kind: plan.kind,
        status: plan.status,
        contextName: ctx.name,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/// The workspace a session belongs to: the one whose Home agent it is,
/// or the one whose pages hold its tab. Null when neither does -- a
/// session that exited, or one this window has not loaded yet.
export function workspaceOfSession(state: WorkspacesData, sessionId: string): string | null {
  for (const ws of state.workspaces) {
    if (ws.mainSessionId === sessionId) return ws.id;
  }
  for (const ws of state.workspaces) {
    for (const page of ws.pages) {
      if (allSessionIds(page.layout).includes(sessionId)) return ws.id;
    }
  }
  return null;
}

/// Why a card cannot be added as a follow-up in this mode, or null.
///
/// Inline rides the daemon's queue, so it is refused on exactly what a
/// typed follow-up is refused on (`queueBlockedReason`, handed in so this
/// module and queuedInput.ts cannot disagree).
///
/// A new tab is the app's own queue, so the version gate does not apply
/// to it -- but an interrupted session does: its turn never ends, so a
/// card waiting on it would wait forever. A question on screen does NOT
/// refuse it: a new tab cannot be mistaken for the answer, and it simply
/// waits for the turn that follows the answer.
export function cardFollowUpRefusal(
  mode: CardFollowUpMode,
  target: QueueTarget,
  queueBlocked: string | null,
  pending: CardFollowUp[],
  cardPath: string
): string | null {
  if (mode === "inline") return queueBlocked;
  if (target.interrupted) {
    return "This tab's agent was stopped and its turn will never end, so a card waiting on it would never open. Run the card from the board instead.";
  }
  if (pending.some((p) => p.cardPath === cardPath)) {
    return "That card is already waiting to open when this agent's turn ends.";
  }
  return null;
}

/// Whether held cards may be launched now: the turn has ended.
///
/// A turn that ended (`endsTurn`: `idle`, `background` or `done`) and
/// nothing else, the same rule the daemon applies to its own queue -- and
/// not while the verdict says the agent stopped on a
/// question, because then the turn has not really ended: the work the
/// card follows is waiting on the human's answer.
export function cardFollowUpsMayFire(target: QueueTarget): boolean {
  if (target.interrupted) return false;
  if (verdictIsAsking(target.verdict)) return false;
  return endsTurn(target.status);
}

/// What the held-cards list says about why its cards have not opened.
/// Null with nothing held.
export function cardFollowUpHold(target: QueueTarget, held: number): string | null {
  if (held === 0) return null;
  if (target.interrupted) {
    return "This tab's agent was stopped, so its turn will never end. Open these now, or cancel them.";
  }
  if (verdictIsAsking(target.verdict) || target.status === "waiting_for_input") {
    return "The agent is asking you something — these open when its next turn ends.";
  }
  switch (target.status) {
    case "working":
      return held === 1
        ? "Opens in a new tab when this agent's turn ends."
        : "These open in new tabs when this agent's turn ends.";
    case "failed":
      return "The agent stopped because something broke, so its turn will not end on its own. Open these now, or cancel them.";
    case "idle":
    case "background":
    case "done":
      return "Opening now.";
    default:
      return "Waiting for the agent.";
  }
}

/// The follow-ups button's hover text, covering both queues: the typed
/// one's own tip, then a line for the cards held for new tabs.
export function followUpButtonTip(queueTip: string | null, held: number): string | null {
  if (held === 0) return queueTip;
  const line = held === 1 ? "1 card to open in a new tab" : `${held} cards to open in new tabs`;
  return queueTip ? `${queueTip}\n${line}` : line;
}

/// A stored blob, entry by entry: one malformed row is dropped, never the
/// rest, and nothing that does not look like a held card reaches the
/// launcher.
export function parseCardFollowUps(raw: string | null): Record<string, CardFollowUp[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, CardFollowUp[]> = {};
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<CardFollowUp>;
    if (typeof e.id !== "string" || !e.id) continue;
    if (typeof e.sessionId !== "string" || !e.sessionId) continue;
    if (typeof e.workspaceId !== "string" || !e.workspaceId) continue;
    if (typeof e.cardPath !== "string" || !e.cardPath) continue;
    if (typeof e.title !== "string") continue;
    if (typeof e.askedAtMs !== "number" || !Number.isFinite(e.askedAtMs)) continue;
    (out[e.sessionId] ??= []).push({
      id: e.id,
      sessionId: e.sessionId,
      workspaceId: e.workspaceId,
      cardPath: e.cardPath,
      title: e.title,
      askedAtMs: e.askedAtMs,
      error: typeof e.error === "string" ? e.error : null,
    });
  }
  return out;
}

export function serializeCardFollowUps(bySession: Record<string, CardFollowUp[]>): string {
  return JSON.stringify(Object.values(bySession).flat());
}
