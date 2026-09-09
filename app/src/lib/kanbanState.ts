import { writable, get } from "svelte/store";
import * as backend from "$lib/backend";
import * as kanban from "$lib/kanban";
import type { Board, CardSession, Column, Label } from "$lib/kanban";

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

// One save-failure message per workspace, shown as a dismissible banner
// on the board (distinct from `errors`, which is only for a board we
// never managed to load).
export const saveErrors = writable<Record<string, string>>({});

export function dismissSaveError(workspaceId: string): void {
  saveErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

// In-flight setBoard count per workspace -- refreshBoard must never
// clobber optimistic state while a save is still resolving.
const pendingSaves = new Map<string, number>();

// Shared by every mutation action below: applies `mutate` to the
// workspace's current board (a no-op if it was never fetched -- there is
// nothing to mutate or persist), writes the result to the store, and
// persists the whole board via setBoard, matching how pane-tree edits
// already flow through layoutState.ts to the daemon. A failed persist
// rolls the optimistic update back (spec §3) -- unless a later mutation
// already replaced it (reference check: every mutation makes a fresh
// board object, and that later mutation's own setBoard carries this
// one's change anyway since the whole board is persisted each time).
async function mutateAndPersist(workspaceId: string, mutate: (board: Board) => Board): Promise<void> {
  const current = get(kanbanState)[workspaceId];
  if (!current) return;
  const updated = mutate(current);
  kanbanState.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await backend.setBoard(workspaceId, updated.columns, updated.labels);
    dismissSaveError(workspaceId);
  } catch (e) {
    kanbanState.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    saveErrors.update((err) => ({
      ...err,
      [workspaceId]: String(e instanceof Error ? e.message : e),
    }));
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

// Re-reads the board from SQLite (spec §3, staleness) -- called on
// window focus and when a board surface (re)mounts. Skipped while a
// mutation is in flight, and checked again after the fetch for saves
// that started meanwhile.
export async function refreshBoard(workspaceId: string): Promise<void> {
  if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
  try {
    const board = await backend.getBoard(workspaceId);
    if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
    kanbanState.update((s) => ({ ...s, [workspaceId]: board }));
    clearError(workspaceId);
  } catch {
    // Keep showing the board we have; the load-error overlay is only
    // for a board we never managed to load.
  }
}








export function cardSessionFor(board: Board | undefined, path: string): CardSession | null {
  return board?.cardSessions.find((cs) => cs.path === path) ?? null;
}

// Card session bindings persist through their own targeted requests
// (not setBoard), with the same optimistic-update / rollback / save-
// error shape as mutateAndPersist.
async function mutateBindings(
  workspaceId: string,
  mutate: (sessions: CardSession[]) => CardSession[],
  persist: () => Promise<void>
): Promise<void> {
  const current = get(kanbanState)[workspaceId];
  if (!current) return;
  const updated: Board = { ...current, cardSessions: mutate(current.cardSessions) };
  kanbanState.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await persist();
    dismissSaveError(workspaceId);
  } catch (e) {
    kanbanState.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    saveErrors.update((err) => ({
      ...err,
      [workspaceId]: String(e instanceof Error ? e.message : e),
    }));
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

export function linkCardSessionAction(workspaceId: string, binding: CardSession): Promise<void> {
  return mutateBindings(
    workspaceId,
    (sessions) => [...sessions.filter((cs) => cs.path !== binding.path), binding],
    () =>
      backend.linkCardSession(
        workspaceId,
        binding.path,
        binding.sessionId,
        binding.cwd,
        binding.command,
        binding.conversationId ?? null,
        binding.launchCwd ?? null,
        // The binding is upserted WHOLE, so an absent count writes
        // zero rather than preserving what was there -- which is right:
        // every call site builds the binding it means, and the sites
        // that mean "a fresh run" are the majority.
        binding.resumeAttempts ?? null,
        // Same rule for the baseline: a caller that leaves it out is
        // saying this run has none, not "keep the last one" -- which
        // matters most for the caller that means it, a re-launch in a
        // checkout that is no longer a repository.
        binding.baseSha ?? null
      )
  );
}

export function unlinkCardSessionAction(workspaceId: string, path: string): Promise<void> {
  return mutateBindings(
    workspaceId,
    (sessions) => sessions.filter((cs) => cs.path !== path),
    () => backend.unlinkCardSession(workspaceId, path)
  );
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

export function deleteColumnAction(workspaceId: string, columnId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.deleteColumn(b, columnId));
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
