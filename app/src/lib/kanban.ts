export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface SessionLink {
  sessionId: string;
  cwd: string;
  command: string | null;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  labelIds: string[];
  priority: Priority;
  position: number;
  sessionLink?: SessionLink;
}

export interface Column {
  id: string;
  name: string;
  position: number;
  cards: Card[];
}

export interface Board {
  columns: Column[];
  labels: Label[];
}

export function addCard(board: Board, columnId: string, card: Card): Board {
  return {
    ...board,
    columns: board.columns.map((c) => (c.id === columnId ? { ...c, cards: [...c.cards, card] } : c)),
  };
}

export function updateCard(
  board: Board,
  cardId: string,
  patch: Partial<Pick<Card, "title" | "description" | "priority" | "labelIds">>
): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)),
    })),
  };
}

// Removes the card from wherever it currently is, reindexes that
// column's remaining cards' `position` to stay contiguous from 0, then
// inserts it into the target column at targetIndex (clamped) with
// `position` reindexed there too. Reordering within the same column is
// the same operation with source and target columns equal.
export function moveCard(board: Board, cardId: string, targetColumnId: string, targetIndex: number): Board {
  let moved: Card | null = null;
  const withoutCard = board.columns.map((c) => {
    const found = c.cards.find((card) => card.id === cardId);
    if (!found) return c;
    moved = found;
    return { ...c, cards: c.cards.filter((card) => card.id !== cardId).map((card, i) => ({ ...card, position: i })) };
  });
  if (!moved) return board;

  return {
    ...board,
    columns: withoutCard.map((c) => {
      if (c.id !== targetColumnId) return c;
      const clamped = Math.max(0, Math.min(targetIndex, c.cards.length));
      const cards = [...c.cards];
      cards.splice(clamped, 0, moved as Card);
      return { ...c, cards: cards.map((card, i) => ({ ...card, position: i })) };
    }),
  };
}

export function deleteCard(board: Board, cardId: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.filter((card) => card.id !== cardId).map((card, i) => ({ ...card, position: i })),
    })),
  };
}

export function linkSession(board: Board, cardId: string, sessionLink: SessionLink): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => (card.id === cardId ? { ...card, sessionLink } : card)),
    })),
  };
}

export function unlinkSession(board: Board, cardId: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => (card.id === cardId ? { ...card, sessionLink: undefined } : card)),
    })),
  };
}

// Replaces just the linked sessionId, preserving the remembered cwd/command
// -- used by "re-launch," which recreates a session at the same cwd/command
// as the one that exited, then points the card at the fresh id.
export function updateSessionLink(board: Board, cardId: string, sessionId: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) =>
        card.id === cardId && card.sessionLink ? { ...card, sessionLink: { ...card.sessionLink, sessionId } } : card
      ),
    })),
  };
}

export function addLabel(board: Board, label: Label): Board {
  return { ...board, labels: [...board.labels, label] };
}

export function updateLabel(board: Board, labelId: string, patch: Partial<Pick<Label, "name" | "color">>): Board {
  return {
    ...board,
    labels: board.labels.map((l) => (l.id === labelId ? { ...l, ...patch } : l)),
  };
}

export function deleteLabel(board: Board, labelId: string): Board {
  return {
    ...board,
    labels: board.labels.filter((l) => l.id !== labelId),
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => ({ ...card, labelIds: card.labelIds.filter((id) => id !== labelId) })),
    })),
  };
}

export function addColumn(board: Board, column: Column): Board {
  return { ...board, columns: [...board.columns, column] };
}

export function renameColumn(board: Board, columnId: string, name: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => (c.id === columnId ? { ...c, name } : c)),
  };
}

export function reorderColumn(board: Board, columnId: string, targetIndex: number): Board {
  const currentIndex = board.columns.findIndex((c) => c.id === columnId);
  if (currentIndex === -1) return board;
  const columns = [...board.columns];
  const [moved] = columns.splice(currentIndex, 1);
  const clamped = Math.max(0, Math.min(targetIndex, columns.length));
  columns.splice(clamped, 0, moved);
  return { ...board, columns: columns.map((c, i) => ({ ...c, position: i })) };
}

export function deleteColumnCascade(board: Board, columnId: string): Board {
  return {
    ...board,
    columns: board.columns.filter((c) => c.id !== columnId).map((c, i) => ({ ...c, position: i })),
  };
}

// Moves every card currently in sourceColumnId to the end of
// targetColumnId's card list, leaving sourceColumnId empty. Callers that
// want to relocate-then-delete (the "move cards" branch of the
// delete-non-empty-column prompt) call this first, then
// deleteColumnCascade on the now-empty source -- two composed primitives
// rather than one combined function, so each stays independently
// testable and reusable (a future "merge two columns" feature could use
// this alone, without deleting anything).
export function moveCardsOutOfColumn(board: Board, sourceColumnId: string, targetColumnId: string): Board {
  const source = board.columns.find((c) => c.id === sourceColumnId);
  if (!source) return board;
  const movingCards = source.cards;
  return {
    ...board,
    columns: board.columns.map((c) => {
      if (c.id === sourceColumnId) return { ...c, cards: [] };
      if (c.id === targetColumnId) {
        const cards = [...c.cards, ...movingCards];
        return { ...c, cards: cards.map((card, i) => ({ ...card, position: i })) };
      }
      return c;
    }),
  };
}
