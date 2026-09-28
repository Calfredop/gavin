import { writable, get } from "svelte/store";
import * as backend from "$lib/core/backend";
import * as kanban from "$lib/board/kanban";
import type { Board, CardSession, CardSessionRecord, Column, Label } from "$lib/board/kanban";

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
  await readBoard(workspaceId);
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

// Which read a workspace's board is waiting for. Every read and every
// save takes the next number, and a read applies its answer only if its
// number is still the latest. `pendingSaves` alone does not cover it: the
// board is read off the main thread, so a read taken before a save can
// land after that save has already resolved and cleared `pendingSaves`,
// putting the pre-save board back. (Two READS never race each other:
// readBoard keeps one out per workspace.)
const boardEpochs = new Map<string, number>();

function nextBoardEpoch(workspaceId: string): number {
  const epoch = (boardEpochs.get(workspaceId) ?? 0) + 1;
  boardEpochs.set(workspaceId, epoch);
  return epoch;
}

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
  nextBoardEpoch(workspaceId);
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
// window focus, when a board surface (re)mounts, and on every tree push.
// Skipped while a mutation is in flight, and dropped afterwards if a save
// started meanwhile (boardEpochs). Coalesced: see readBoard.
export function refreshBoard(workspaceId: string): Promise<void> {
  return readBoard(workspaceId);
}

// One board read per workspace at a time. Every caller that arrives while
// one is pending joins it, and one that arrives after it has left marks it
// to go round once more -- so a burst costs one read, plus at most one
// trailing read for whatever changed while the first was out. The bursts
// are real: every card write by any agent is a tree push, each push asks
// for the board, and so does every mounted board surface on window focus.
//
// The first read waits one microtask (never a timer -- a detached
// setTimeout throws in WKWebView), so every caller in the same task joins
// it before it leaves: a surface's fetchBoard + refreshBoard on mount, or
// three focus handlers, are one read, not three.
interface BoardRead {
  again: boolean;
  done: Promise<void>;
}
const boardReads = new Map<string, BoardRead>();

function readBoard(workspaceId: string): Promise<void> {
  const pending = boardReads.get(workspaceId);
  if (pending) {
    pending.again = true;
    return pending.done;
  }
  const read: BoardRead = { again: true, done: Promise.resolve() };
  boardReads.set(workspaceId, read);
  read.done = (async () => {
    try {
      await Promise.resolve();
      while (read.again) {
        read.again = false;
        await readBoardOnce(workspaceId);
      }
    } finally {
      boardReads.delete(workspaceId);
    }
  })();
  return read.done;
}

async function readBoardOnce(workspaceId: string): Promise<void> {
  if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
  const epoch = nextBoardEpoch(workspaceId);
  try {
    const board = await backend.getBoard(workspaceId);
    if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
    // A save that started while this read was out owns the board now.
    // Only for a board already loaded: a first load has nothing to lose
    // to, and must never leave the store empty.
    if (boardEpochs.get(workspaceId) !== epoch && workspaceId in get(kanbanState)) return;
    kanbanState.update((s) => ({ ...s, [workspaceId]: board }));
    clearError(workspaceId);
  } catch (e) {
    // Keep showing the board we have; the load-error overlay is only
    // for a board we never managed to load.
    if (workspaceId in get(kanbanState)) return;
    errors.update((err) => ({ ...err, [workspaceId]: String(e instanceof Error ? e.message : e) }));
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
  nextBoardEpoch(workspaceId);
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

export function linkCardSessionAction(workspaceId: string, binding: CardSessionRecord): Promise<void> {
  // The board keeps the binding without its command, exactly as the next
  // read will bring it back (CardSession).
  const { command: _command, ...onBoard } = binding;
  return mutateBindings(
    workspaceId,
    (sessions) => [...sessions.filter((cs) => cs.path !== binding.path), onBoard],
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
