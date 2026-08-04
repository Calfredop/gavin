import { writable, get } from "svelte/store";
import * as backend from "./backend";
import * as kanban from "./kanban";
import type { Board, Card, Column, Label } from "./kanban";

export const kanbanState = writable<Record<string, Board>>({});

const errors = writable<Record<string, string>>({});

export function boardError(workspaceId: string): string | null {
  return get(errors)[workspaceId] ?? null;
}

function clearError(workspaceId: string): void {
  errors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

export async function fetchBoard(workspaceId: string): Promise<void> {
  if (workspaceId in get(kanbanState)) return;
  try {
    const board = await backend.getBoard(workspaceId);
    kanbanState.update((s) => ({ ...s, [workspaceId]: board }));
    clearError(workspaceId);
  } catch (e) {
    errors.update((err) => ({ ...err, [workspaceId]: String(e instanceof Error ? e.message : e) }));
  }
}

export async function retryFetchBoard(workspaceId: string): Promise<void> {
  clearError(workspaceId);
  kanbanState.update((s) => {
    if (!(workspaceId in s)) return s;
    const { [workspaceId]: _removed, ...rest } = s;
    return rest;
  });
  await fetchBoard(workspaceId);
}

// Shared by every mutation action below: applies `mutate` to the
// workspace's current board (a no-op if it was never fetched -- there is
// nothing to mutate or persist), writes the result to the store, and
// persists the whole board via setBoard, matching how pane-tree edits
// already flow through layoutState.ts to the daemon.
async function mutateAndPersist(workspaceId: string, mutate: (board: Board) => Board): Promise<void> {
  const current = get(kanbanState)[workspaceId];
  if (!current) return;
  const updated = mutate(current);
  kanbanState.update((s) => ({ ...s, [workspaceId]: updated }));
  await backend.setBoard(workspaceId, updated.columns, updated.labels);
}

export function addCardAction(workspaceId: string, columnId: string, card: Card): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.addCard(b, columnId, card));
}

export function updateCardAction(
  workspaceId: string,
  cardId: string,
  patch: Partial<Pick<Card, "title" | "description" | "priority" | "labelIds">>
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.updateCard(b, cardId, patch));
}

export function moveCardAction(
  workspaceId: string,
  cardId: string,
  targetColumnId: string,
  targetIndex: number
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.moveCard(b, cardId, targetColumnId, targetIndex));
}

export function deleteCardAction(workspaceId: string, cardId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.deleteCard(b, cardId));
}

export function addColumnAction(workspaceId: string, column: Column): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.addColumn(b, column));
}

export function renameColumnAction(workspaceId: string, columnId: string, name: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.renameColumn(b, columnId, name));
}

export function reorderColumnAction(workspaceId: string, columnId: string, targetIndex: number): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.reorderColumn(b, columnId, targetIndex));
}

export function deleteColumnCascadeAction(workspaceId: string, columnId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.deleteColumnCascade(b, columnId));
}

export function moveCardsOutOfColumnAndDeleteAction(
  workspaceId: string,
  sourceColumnId: string,
  targetColumnId: string
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) =>
    kanban.deleteColumnCascade(kanban.moveCardsOutOfColumn(b, sourceColumnId, targetColumnId), sourceColumnId)
  );
}

export function addLabelAction(workspaceId: string, label: Label): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.addLabel(b, label));
}

export function updateLabelAction(
  workspaceId: string,
  labelId: string,
  patch: Partial<Pick<Label, "name" | "color">>
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.updateLabel(b, labelId, patch));
}

export function deleteLabelAction(workspaceId: string, labelId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.deleteLabel(b, labelId));
}
