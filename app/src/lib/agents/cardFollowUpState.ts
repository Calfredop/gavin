// The app-held half of "card as a follow-up": cards waiting to be RUN in
// a new tab when a session's turn ends, and the watcher that runs them.
//
// The inline half needs none of this -- it is a typed follow-up with a
// composed prompt, and the daemon's queue holds it (queueCardFollowUp).
// A new tab is a launch, which the daemon has no queue for, so it waits
// here: per WINDOW and in localStorage, exactly like the launch queue and
// for its reason -- a reload is not a decision, and no daemon request
// means no protocol bump and no compat gate.

import { derived, get, writable } from "svelte/store";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { cardViewForPath } from "$lib/core/planBoard";
import { kanbanState, cardSessionFor } from "$lib/board/kanbanState";
import { currentWindowLabel } from "$lib/shell/appWindowState";
import { turnVerdictById } from "$lib/agents/turnVerdictState";
import { queueTargetFor } from "$lib/agents/queuedInputActions";
import {
  cardFollowUpsMayFire,
  parseCardFollowUps,
  serializeCardFollowUps,
  workspaceOfSession,
  type CardFollowUp,
} from "$lib/agents/cardFollowUp";

/// Held cards by the session whose turn they wait on, in the order they
/// were added. A session with nothing held has no key.
export const cardFollowUpsById = writable<Record<string, CardFollowUp[]>>({});

/// Total held for one session -- what the follow-ups button adds to its
/// badge.
export const heldCardCountById = derived(cardFollowUpsById, (byId) => {
  const out: Record<string, number> = {};
  for (const [id, list] of Object.entries(byId)) out[id] = list.length;
  return out;
});

function storageKey(): string {
  return `gavin.cardFollowUps.${currentWindowLabel()}`;
}

function load(): Record<string, CardFollowUp[]> {
  try {
    return typeof localStorage === "undefined"
      ? {}
      : parseCardFollowUps(localStorage.getItem(storageKey()));
  } catch {
    return {};
  }
}

function save(byId: Record<string, CardFollowUp[]>): void {
  try {
    if (typeof localStorage === "undefined") return;
    const blob = serializeCardFollowUps(byId);
    if (blob === "[]") localStorage.removeItem(storageKey());
    else localStorage.setItem(storageKey(), blob);
  } catch {
    // A full or blocked store costs persistence across a reload, never
    // the held card in this window.
  }
}

function setList(sessionId: string, list: CardFollowUp[]): void {
  cardFollowUpsById.update((byId) => {
    const next = { ...byId };
    if (list.length === 0) delete next[sessionId];
    else next[sessionId] = list;
    return next;
  });
}

function listFor(sessionId: string): CardFollowUp[] {
  return get(cardFollowUpsById)[sessionId] ?? [];
}

let seq = 0;

/// Holds a card to run in a new tab when `sessionId`'s turn ends. If the
/// turn has ALREADY ended the watcher fires it at once, the same way the
/// daemon hands a typed follow-up straight over to an idle agent.
export function holdCardFollowUp(
  sessionId: string,
  workspaceId: string,
  card: { id: string; title: string }
): void {
  const entry: CardFollowUp = {
    id: `cf-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    sessionId,
    workspaceId,
    cardPath: card.id,
    title: card.title,
    askedAtMs: Date.now(),
    error: null,
  };
  setList(sessionId, [...listFor(sessionId), entry]);
}

export function cancelCardFollowUp(sessionId: string, id: string): void {
  setList(sessionId, listFor(sessionId).filter((e) => e.id !== id));
}

/// Runs one held card now, whatever the session is doing: the override
/// for a turn the human has decided not to wait for, and the only way an
/// entry whose launch was refused goes again.
export function openCardFollowUpNow(sessionId: string, id: string): Promise<void> {
  const entry = listFor(sessionId).find((e) => e.id === id);
  return entry ? fire(entry) : Promise.resolve();
}

/// Entries mid-launch. Removed from the list BEFORE the launch is
/// awaited, because a launch moves the stores this watcher listens to (a
/// new tab, a status write) and every one of those would otherwise fire
/// the same card again while the first launch was still in flight.
const launching = new Set<string>();

async function fire(entry: CardFollowUp): Promise<void> {
  if (launching.has(entry.id)) return;
  launching.add(entry.id);
  setList(entry.sessionId, listFor(entry.sessionId).filter((e) => e.id !== entry.id));
  let error: string | null;
  try {
    error = await launch(entry);
  } catch (e) {
    error = `Couldn't open that card: ${e instanceof Error ? e.message : e}`;
  } finally {
    launching.delete(entry.id);
  }
  // Put back, at its old place in line, with the reason -- and with
  // automatic firing off (see `CardFollowUp.error`).
  if (error) setList(entry.sessionId, [{ ...entry, error }, ...listFor(entry.sessionId)]);
}

async function launch(entry: CardFollowUp): Promise<string | null> {
  const card = cardViewForPath(get(gavinTrees)[entry.workspaceId], entry.cardPath);
  if (!card) return "This card is no longer on the board.";
  // Imported lazily: cardRunActions reaches most of the app, and this
  // module is loaded at startup from layoutState.
  const { runCard, launchCardAsNewSession } = await import("$lib/cards/cardRunActions");
  // A card that already has a session gets a FRESH one rather than a
  // jump: what the human asked for is a new tab, and a jump would yank
  // them to an old one at a moment they did not choose. A live one is
  // refused by `launchCardAsNewSession` itself.
  const bound = cardSessionFor(get(kanbanState)[entry.workspaceId], card.id);
  return bound ? launchCardAsNewSession(entry.workspaceId, card) : runCard(entry.workspaceId, card);
}

/// One pass: every session whose turn has ended fires its held cards, in
/// order; entries a refused launch put back wait for the human.
function tick(): void {
  const state = get(layoutState);
  const verdicts = get(turnVerdictById);
  for (const [sessionId, list] of Object.entries(get(cardFollowUpsById))) {
    // A session no workspace holds any more was closed: its turn will
    // never end, and its cards would wait, invisible, for ever. Only once
    // the workspaces have loaded, so a startup snapshot with none in it
    // does not read as every session closed.
    if (
      state.workspaces.length > 0 &&
      state.sessionStatusById[sessionId] === undefined &&
      workspaceOfSession(state, sessionId) === null
    ) {
      setList(sessionId, []);
      continue;
    }
    const target = queueTargetFor(
      state.sessionStatusById[sessionId],
      state.interruptedSessionIds.has(sessionId),
      verdicts[sessionId] ?? null
    );
    if (!cardFollowUpsMayFire(target)) continue;
    for (const entry of list) {
      if (!entry.error) void fire(entry);
    }
  }
}

let unsubscribes: Array<() => void> = [];

/// Starts the watcher. Module-level, like the launch queue: a card that
/// only opens while its pane is mounted is a card that never opens.
export function startCardFollowUps(): () => void {
  stopCardFollowUps();
  // Merged with anything already live, for the launch queue's reason: a
  // dev-server remount re-runs this with a populated store.
  const stored = load();
  cardFollowUpsById.update((live) => {
    const merged = { ...stored };
    for (const [id, list] of Object.entries(live)) {
      const seen = new Set((merged[id] ?? []).map((e) => e.id));
      merged[id] = [...(merged[id] ?? []), ...list.filter((e) => !seen.has(e.id))];
    }
    return merged;
  });
  unsubscribes = [
    cardFollowUpsById.subscribe((byId) => {
      save(byId);
      tick();
    }),
    layoutState.subscribe(() => tick()),
    turnVerdictById.subscribe(() => tick()),
  ];
  return stopCardFollowUps;
}

export function stopCardFollowUps(): void {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
}

/// Test-only reset.
export function __resetCardFollowUpsForTesting(): void {
  stopCardFollowUps();
  launching.clear();
  cardFollowUpsById.set({});
}
