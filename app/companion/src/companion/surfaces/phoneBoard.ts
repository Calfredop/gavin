// A workspace's board, as a phone draws it: one column on screen at a
// time, the rest a tap away.
//
// The projection is the desktop's (`mergePlanCards`) and so is every
// word on a card; what this adds is only the shape a narrow screen needs
// -- a flat list of columns, which one to open on, and each card's agent
// as a badge rather than as a control.
import { cardSessionState } from "$lib/board/columnRunAction";
import type { Board, Label } from "$lib/board/kanban";
import { cardSessionFor } from "$lib/board/kanbanState";
import type { GavinTree } from "$lib/core/gavin";
import type { SessionStatus } from "$lib/core/notifications";
import { mergePlanCards, slugStatus, type CardView } from "$lib/core/planBoard";
import type { WorkspacesData } from "$lib/core/workspace";
import {
  kanbanColumnChips,
  kanbanSummary,
  type ColumnTone,
} from "$lib/sidebar/sidebarSummary";
import {
  agentExitedIndicator,
  agentFailedIndicator,
  agentIndicator,
  agentInterruptedIndicator,
  type Indicator,
} from "$lib/ui/indicators";

export interface PhoneColumn {
  key: string;
  name: string;
  tone: ColumnTone;
  cards: CardView[];
  /// A status no column of the board matches. The desk draws these as
  /// columns of their own after the board's, and so does this.
  unmatched: boolean;
}

export interface PhoneBoard {
  columns: PhoneColumn[];
  labels: Label[];
}

/// The board's columns, or null until the board itself has arrived. A
/// tree that has not arrived yet is columns over no cards, exactly as on
/// the desk.
export function phoneBoard(board: Board | undefined, tree: GavinTree | undefined): PhoneBoard | null {
  if (!board) return null;
  const merged = mergePlanCards(board, tree);
  // The tones come from the sidebar's own fold over the same projection,
  // in the same order, so a column cannot be one colour in the list and
  // another on its board.
  const tones = kanbanColumnChips(kanbanSummary(board, tree)).map((chip) => chip.tone);
  const columns: PhoneColumn[] = [
    ...merged.columns.map((c) => ({
      key: `column:${c.column.id}`,
      name: c.column.name,
      cards: c.planCards,
      unmatched: false,
    })),
    ...merged.autoColumns.map((a) => ({
      key: `status:${slugStatus(a.status)}`,
      name: a.status,
      cards: a.planCards,
      unmatched: true,
    })),
  ].map((column, index) => ({ ...column, tone: tones[index] ?? "progress" }));
  return { columns, labels: board.labels };
}

/// The key of the column a board opens on.
///
/// Work in flight first. A phone is picked up to see what the agents are
/// doing, and on a board that opens on its first column that is always
/// one swipe past a list of things nobody has started.
export function openingColumn(columns: PhoneColumn[]): string | null {
  const inFlight = columns.find((c) => c.tone === "progress" && c.cards.length > 0);
  const occupied = columns.find((c) => c.cards.length > 0);
  return (inFlight ?? occupied ?? columns[0])?.key ?? null;
}

export interface AgentsInput {
  board: Board | undefined;
  layout: WorkspacesData & {
    interruptedSessionIds: ReadonlySet<string>;
    failureReasonById: Record<string, string>;
  };
  /// The statuses as the attention surfaces read them.
  statusById: Record<string, SessionStatus>;
}

/// The badge for the agent bound to a card, or null where none is.
///
/// The desk's card draws this same badge as a BUTTON that jumps to the
/// session, which moves the desk's tabs. Here it is only the badge: the
/// vocabulary is `BoardCard`'s, composed from the same desktop functions
/// in the same order, and the switch is exhaustive so a state the desk
/// learns later is a type error here rather than a missing glyph.
export function cardAgent(input: AgentsInput, cardId: string): Indicator | null {
  const binding = cardSessionFor(input.board, cardId);
  if (!binding) return null;
  const state = cardSessionState(input.layout, binding);
  switch (state) {
    case "none":
      return null;
    case "interrupted":
      return agentInterruptedIndicator();
    case "failed":
      return agentFailedIndicator(input.layout.failureReasonById[binding.sessionId]);
    case "exited":
      return agentExitedIndicator();
    case "live":
      return agentIndicator(input.statusById[binding.sessionId]);
  }
}

/// How the pager moves to a column that was tapped.
///
/// A glide is drawn frame by frame, and a page that is not being drawn
/// gets no frames: the scroll is accepted and never happens, leaving the
/// strip naming one column over a pager showing another. So it glides
/// only where it will be seen, and jumps everywhere else.
export function scrollBehaviour(page: { reducedMotion: boolean; visible: boolean }): ScrollBehavior {
  return page.reducedMotion || !page.visible ? "auto" : "smooth";
}

/// The key of the column a pager is showing, from how far it has
/// scrolled: the one taking most of the screen. Clamped, because a pager
/// pulled past either end reports a position no column is at.
export function columnAt(keys: string[], scrollLeft: number, width: number): string | null {
  if (width <= 0 || keys.length === 0) return null;
  const index = Math.min(keys.length - 1, Math.max(0, Math.round(scrollLeft / width)));
  return keys[index];
}
