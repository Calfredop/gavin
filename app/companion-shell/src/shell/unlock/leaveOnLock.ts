// What the shell does with an open Workstation when the Unlock ends.
//
// The Unlock gates the connection, not the screen: when it ends, the live
// hub drops every connection, but a paired Workstation's bundle stays in
// front with the last cards, sessions and file names it drew, and nothing
// in it offers an Unlock. The shell goes back to the hub instead, where the
// Unlock is.
//
// The Demo Workstation is the exception: it is hosted here, needs no
// connection and shows nothing of the owner's, so locking has nothing to
// protect in it.
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
