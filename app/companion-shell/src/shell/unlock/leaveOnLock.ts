// What the shell does with an open Workstation when the Unlock ends.
//
// The Unlock gates the connection, not the screen: when it ends, the live
// hub drops every connection, but a paired Workstation's bundle stays in
// front with the last cards, sessions and file names it drew, and nothing
// in it offers an Unlock. The shell goes back to the hub instead, where the
// Unlock is, and once the Unlock is back it returns to the Workstation it
// left: closing loses the bundle's place, not the owner's.
//
// The Demo Workstation is the exception: it is hosted here, needs no
// connection and shows nothing of the owner's, so locking has nothing to
// protect in it.
import type { HubWorkstation } from "$shell/hub/workstations";
import type { UnlockState } from "$shell/unlock/unlock";
import type { VisitState } from "$shell/visit/visit";

/// Whether the shell leaves the visit it is in: a paired Workstation is
/// opening or open and the Unlock is gone.
///
/// Only `locked` leaves. `unlocking` asks again over the visit (Android's
/// auth window lapsing while the connections stay), and `unlocked` is the
/// state a visit needs.
export function leavesVisitOnLock(unlock: UnlockState, visit: VisitState): boolean {
  if (unlock.state !== "locked") return false;
  switch (visit.status) {
    case "opening":
    case "open":
      return !visit.workstation.demo;
    case "hub":
    case "failed":
      return false;
  }
}

/// How long after the Unlock is back the shell still returns to the
/// Workstation it left. Its connection is ready well inside this; one that
/// takes longer is offline, and opening it whenever it comes back would
/// pull the owner out of whatever they turned to on the hub.
export const RETURN_WINDOW_MS = 15_000;

/// The Workstation the lock left, waiting for the Unlock.
export interface PendingReturn {
  workstation: string;
  /// When the Unlock came back, by the page's clock; null while it is
  /// still locked.
  unlockedAt: number | null;
}

/// What to remember about the visit the lock leaves: the paired
/// Workstation it was in, never the Demo, which it does not leave.
export function returnFor(visit: VisitState): PendingReturn | null {
  if (visit.status !== "opening" && visit.status !== "open") return null;
  if (visit.workstation.demo) return null;
  return { workstation: visit.workstation.id, unlockedAt: null };
}

/// One step of the way back. `open` is the Workstation to reopen now;
/// `pending` is what is still waited for.
export function stepReturn(
  pending: PendingReturn | null,
  unlock: UnlockState,
  visit: VisitState,
  workstations: readonly HubWorkstation[],
  now: number
): { pending: PendingReturn | null; open: HubWorkstation | null } {
  // The owner went somewhere else, or there is nothing to go back to.
  if (!pending || visit.status !== "hub") return { pending: null, open: null };
  if (unlock.state !== "unlocked") {
    return { pending: pending.unlockedAt === null ? pending : { ...pending, unlockedAt: null }, open: null };
  }
  const unlockedAt = pending.unlockedAt ?? now;
  const workstation = workstations.find((ws) => ws.id === pending.workstation);
  if (!workstation || now - unlockedAt > RETURN_WINDOW_MS) return { pending: null, open: null };
  if (workstation.openable) return { pending: null, open: workstation };
  return { pending: { ...pending, unlockedAt }, open: null };
}
