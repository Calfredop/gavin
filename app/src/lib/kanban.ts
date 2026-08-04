export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  labelIds: string[];
  priority: Priority;
  position: number;
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
