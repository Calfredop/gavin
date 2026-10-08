// The Decisions and Review surfaces: the cards in a workspace that carry
// a `Decision:` still to answer, or a `Human test:` still owed, each with
// its items answered in place -- and the desk's "Clean stale …" agent
// over the whole list.
//
// The lists are the desk's own. Decisions is `decisionsList` with no
// sessions and no rails handed in, which leaves exactly its card rows:
// an agent waiting in its terminal is the Sessions surface's to show,
// and a rail parked on a gate the Rails surface's. Review is the Review
// tab's `humanTestList` without the diff it sits beside, which a phone
// has no room for. So the phone and the desk cannot disagree about which
// cards are owed anything, and the clean action is handed the same
// entries the desk's would be (`cleanEntries`).
//
// Pure. The launch is state/decisions.ts's.
import type { Board } from "$lib/board/kanban";
import type { GavinTree, HumanItem } from "$lib/core/gavin";
import {
  CLEAN_LABEL,
  cleanBlocker,
  cleanEntries,
  type CleanEntry,
  type CleanKind,
} from "$lib/decisions/cleanStale";
import { decisionsList, humanItemWaiting } from "$lib/decisions/decisions";
import { humanTestList } from "$lib/review/humanTests";
import { cardIndex, doneColumnOf } from "$lib/orchestration/orchestration";

/// One card the surface lists.
export interface ItemCard {
  cardPath: string;
  title: string;
  /// The card's effective status, for its chip.
  status: string | null;
  /// What is still owed on it, in file order: open items, and (on
  /// Review) failed tests the agent has not re-armed yet.
  items: HumanItem[];
}

export interface ItemsInput {
  workspaceId: string;
  tree: GavinTree | undefined;
  board: Board | undefined;
  hasRoot: boolean;
  /// `featureBlockedReason(compat, "humanItems")`: an older daemon parses
  /// no item lines, and its silence is not "nothing owed".
  itemsBlockedReason: string | null;
}

export interface ItemsList {
  cards: ItemCard[];
  /// Why the cards cannot be shown, when they cannot.
  blocked: string | null;
  /// The head's count, or null with nothing waiting on the human.
  summary: string | null;
  /// What "Clean stale …" would be handed: the WHOLE list, as at the desk.
  cleanable: CleanEntry[];
  /// Why a clean cannot start, or null. A phone has no tooltip, so the
  /// press says this rather than going dead (state/decisions.ts).
  cleanBlocked: string | null;
  cleanLabel: string;
}

export function phoneItems(kind: CleanKind, input: ItemsInput): ItemsList {
  const cards = new Map(
    [...cardIndex(input.tree)].map(([path, entry]) => [path, { plan: entry.plan, contextFolder: entry.contextFolder }])
  );
  const bindings = new Map((input.board?.cardSessions ?? []).map((cs) => [cs.path, cs.sessionId]));
  const doneStatus = doneColumnOf(input.board?.columns ?? [])?.name ?? null;
  const itemsBlockedReason = input.itemsBlockedReason;

  let rows: ItemCard[];
  if (kind === "decisions") {
    const list = decisionsList({
      workspaceId: input.workspaceId,
      cards,
      bindings,
      inbox: [],
      rails: [],
      marks: new Map(),
      doneStatus,
      itemsBlockedReason,
    });
    rows = list.subjects.flatMap((s) =>
      s.kind === "card" ? [{ cardPath: s.cardPath, title: s.title, status: s.status, items: s.items }] : []
    );
  } else {
    const list = humanTestList({ cards, bindings, doneStatus, itemsBlockedReason });
    rows = list.subjects.map((s) => ({ cardPath: s.cardPath, title: s.title, status: s.status, items: s.items }));
  }

  const cleanable = cleanEntries(rows);
  return {
    cards: rows,
    blocked: itemsBlockedReason,
    summary: summaryLine(kind, rows),
    cleanable,
    cleanBlocked: cleanBlocker({ kind, entries: cleanable, itemsBlockedReason, hasRoot: input.hasRoot }),
    cleanLabel: CLEAN_LABEL[kind],
  };
}

/// Items, not cards: one card can ask three things, and that is three
/// things to do. A failed test is the agent's, and not counted.
function summaryLine(kind: CleanKind, rows: readonly ItemCard[]): string | null {
  const waiting = rows.reduce((n, r) => n + r.items.filter(humanItemWaiting).length, 0);
  if (waiting === 0) return null;
  const noun = kind === "decisions" ? "decision" : "test";
  return `${waiting} ${noun}${waiting === 1 ? "" : "s"} waiting on you`;
}

/// The empty list's sentence, by what the surface lists -- never the
/// desk's "Nothing in this workspace is waiting on you": with sessions
/// and gates left to their own surfaces, that would overclaim.
export const NOTHING_OWED: Record<CleanKind, string> = {
  decisions: "No card in this workspace has a decision waiting on you.",
  tests: "No card in this workspace has a human test owed.",
};
