// Which Device each session takes input from, one copy per window (v68).
//
// The stores, the listener and the three gestures -- Take over (Take back at
// the desk), Hand over and Release -- over `sessionOwnership.ts`'s rules. The
// desk and the Companion bundle both run this module: the desk is the viewer
// `null`, a Device the id the daemon tells it is its own (`you`), so the lock
// either one draws is the same lock.
//
// The daemon is the arbiter. A gesture names the owner this window last saw
// (`expect`), so one that lost a race comes back refused with who won, and a
// holder typing a moment ago comes back `busy` and is asked about before it is
// sent again with `force`.

import { derived, get, writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { askConfirm } from "$lib/core/dialog";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import { daemonCompat } from "$lib/core/layoutState";
import { setInputGate } from "$lib/terminal/terminalRegistry";
import {
  busyQuestion,
  lockFor,
  ownerRefusalFrom,
  ownersChangeAt,
  ownersFromList,
  refusalText,
  takeLabel,
  withOwnership,
  type LiveDevice,
  type OwnerRefusal,
  type Owners,
  type SessionOwner,
  type SessionOwnership,
  type Viewer,
} from "$lib/core/sessionOwnership";

const owners = writable<Owners>({});
const devices = writable<LiveDevice[]>([]);
/// Who this window is: `undefined` until the first read says.
const viewer = writable<Viewer>(undefined);
/// The clock a lock's "typed 12s ago" is read against. Moved by a push,
/// and on `ownersChangeAt`'s schedule while any session is owned.
const clock = writable(Date.now());

export const sessionOwners: Readable<Owners> = { subscribe: owners.subscribe };
export const liveDevices: Readable<LiveDevice[]> = { subscribe: devices.subscribe };
export const ownershipViewer: Readable<Viewer> = { subscribe: viewer.subscribe };
export const ownerClock: Readable<number> = { subscribe: clock.subscribe };

/// Why this Workstation locks nothing, or null: a daemon older than v68.
/// A function of the verdict rather than a store over it, so a suite that
/// mocks part of `layoutState` can still import this module.
export function ownershipBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "sessionOwnership");
}

/// The owner each locked session is locked by, for this window.
export const lockBySessionId: Readable<Record<string, SessionOwner>> = derived(
  [owners, viewer],
  ([$owners, $viewer]) => {
    const out: Record<string, SessionOwner> = {};
    for (const sessionId of Object.keys($owners)) {
      const owner = lockFor($owners, sessionId, $viewer);
      if (owner) out[sessionId] = owner;
    }
    return out;
  }
);

let clockTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleClock(): void {
  if (clockTimer !== null) clearTimeout(clockTimer);
  clockTimer = null;
  const now = Date.now();
  clock.set(now);
  const next = ownersChangeAt(get(owners), now);
  if (next !== null) clockTimer = setTimeout(scheduleClock, Math.max(next - now, 0));
}

function apply(ownership: SessionOwnership): void {
  owners.update((all) => withOwnership(all, ownership));
  scheduleClock();
}

let token = 0;

/// Re-reads who owns what, the live Devices, and who this window is. A
/// no-op against a daemon too old to be asked; a read that fails leaves the
/// last answer standing, and a window that never got one locks nothing.
export async function refreshSessionOwners(): Promise<void> {
  if (ownershipBlocked(get(daemonCompat))) return;
  const mine = ++token;
  try {
    const list = await backend.listSessionOwners();
    if (mine !== token) return;
    owners.set(ownersFromList(list.owners));
    devices.set(list.devices);
    viewer.set(list.you ?? null);
    scheduleClock();
  } catch {
    // Not knowing who owns a session is not a reason to lock it.
  }
}

/// The owner this window would be locked out of `sessionId` by, now.
export function lockOf(sessionId: string): SessionOwner | null {
  return lockFor(get(owners), sessionId, get(viewer));
}

/// Why this window may not send input into `sessionId` now, or null. What
/// every input surface asks before it sends -- the compose box, a follow-up,
/// a card handed to the workspace agent -- so a locked session says who has
/// it instead of taking the text.
export function inputLockedReason(sessionId: string): string | null {
  const owner = lockOf(sessionId);
  return owner ? refusalText({ kind: "owned", sessionId, owner }, get(viewer)) : null;
}

/// Makes `to` (a Device's id, or null for the desk) the owner of
/// `sessionId`, as this window last saw it. Asks first when the holder is
/// typing, unless `force` says the human already answered that. Returns
/// what to say, or null when it is done -- or when the human answered the
/// question with no.
async function changeOwner(sessionId: string, to: string | null, force = false): Promise<string | null> {
  const expect = get(owners)[sessionId]?.deviceId ?? null;
  const send = async (force: boolean): Promise<void> => apply(await backend.setSessionOwner(sessionId, to, expect, force));
  try {
    await send(force);
    return null;
  } catch (e) {
    const refusal = ownerRefusalFrom(e);
    if (refusal?.kind !== "busy") return failure(e, refusal);
    const taking = to === get(viewer);
    const yes = await askConfirm({
      title: busyQuestion(refusal),
      lines: [`${refusal.owner?.name ?? "The desk"} will see it locked, and can take it back.`],
      confirmLabel: taking ? takeLabel(get(viewer)) : "Hand over",
      danger: true,
    });
    if (!yes) return null;
    try {
      await send(true);
      return null;
    } catch (again) {
      return failure(again, ownerRefusalFrom(again));
    }
  }
}

function failure(e: unknown, refusal: OwnerRefusal | null): string {
  if (refusal === null) {
    return `Couldn't change who owns this session: ${e instanceof Error ? e.message : String(e)}`;
  }
  return noteRefusal(refusal);
}

/// A refusal heard back from a write or a change: what to say about it. A
/// race lost, or a write into a session another Device owns, is news about
/// who has it now, so that is drawn first -- the lock appears before the
/// sentence that explains it.
export function noteRefusal(refusal: OwnerRefusal): string {
  if (refusal.kind === "changed" || refusal.kind === "owned") {
    apply({ sessionId: refusal.sessionId, owner: refusal.owner ?? null, reason: "other", at: Date.now() / 1000 });
  }
  return refusalText(refusal, get(viewer));
}

/// Take over -- Take back, at the desk. `force` when the human has already
/// said yes to taking it from someone typing.
export function takeOver(sessionId: string, force = false): Promise<string | null> {
  const me = get(viewer);
  if (me === undefined) return Promise.resolve("Still finding out who owns this session. Try again in a moment.");
  return changeOwner(sessionId, me, force);
}

/// Hands a session to another Device, or (null) back to the desk.
export function handOver(sessionId: string, to: string | null): Promise<string | null> {
  return changeOwner(sessionId, to);
}

/// The owner giving its session back to the desk.
export function release(sessionId: string): Promise<string | null> {
  return changeOwner(sessionId, null);
}

/// Starts listening, and holds every terminal's keyboard to the lock;
/// returns the stop. Called once per window: the desk's sidebar, the
/// Companion's Workstation state.
export function watchSessionOwners(): () => void {
  // Whatever an earlier watch knew is another connection's -- on a Device,
  // perhaps another Workstation's, where it was someone else.
  forget();
  const releaseGate = setInputGate((sessionId) => lockOf(sessionId) === null);
  const stop: Promise<UnlistenFn>[] = [
    listen<SessionOwnership>("session-owner-changed", (event) => apply(event.payload)),
    // Who a session can be handed to changes with who is connected.
    listen<string>("device-connected", () => void refreshSessionOwners()),
    listen<string>("device-disconnected", () => void refreshSessionOwners()),
  ];
  // The first read waits for a verdict, like the Devices list's.
  const unsubscribe = daemonCompat.subscribe(() => {
    if (get(viewer) === undefined) void refreshSessionOwners();
  });
  return () => {
    unsubscribe();
    releaseGate();
    for (const p of stop) void p.then((off) => off());
    forget();
  };
}

/// Back to knowing nothing: no owners, no Devices, and not who this is.
function forget(): void {
  token += 1;
  owners.set({});
  devices.set([]);
  viewer.set(undefined);
  if (clockTimer !== null) clearTimeout(clockTimer);
  clockTimer = null;
}
