// Whether the Workstation can be reached, as the shell says (the channel's
// `connection` message), and what the open screen does about it.
//
// A surface that fetches once when it opens -- Git's status, the board,
// a folder of Files -- never learns on its own that a read it failed
// would succeed now, and an error banner about an outage outlives the
// outage until someone dismisses it. So:
//
// - **Down**: the page says so once (`reachabilityLine`), and an error
//   that only says the Workstation could not be reached is not repeated
//   beside it (`shownError`).
// - **Back up**: every surface that is open re-runs its own load once
//   (`onReconnect`), clearing the reachability errors it showed first.
//   An error that is the Workstation's own -- git refusing, a file that
//   is not there -- is not about reachability and stays.
//
// Which errors are about reachability is told by the wire, not guessed
// from their words: a call the shell could not carry is answered with the
// code `unreachable`, and the shim notes its message here
// (`noteUnreachable`). The desktop's modules then fold that message into
// their own sentences ("Refresh failed: …"), which is why a banner is
// matched by containing one.
import { get, writable, type Readable } from "svelte/store";
import type { ConnectionState } from "$companion/channel/messages";

const UP: ConnectionState = { state: "up" };

const store = writable<ConnectionState>(UP);

export const reachability: Readable<ConnectionState> = { subscribe: store.subscribe };

/// The messages calls were refused with because the Workstation could not
/// be reached.
const unreachable = new Set<string>();

/// What each open surface re-runs when the connection comes back.
const recoveries = new Set<() => void>();

/// A call was refused as `unreachable`, with these words.
export function noteUnreachable(message: string): void {
  if (message) unreachable.add(message);
}

/// Whether an error on screen only says the Workstation could not be
/// reached.
export function isReachabilityError(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const message of unreachable) if (text.includes(message)) return true;
  return false;
}

/// The error a surface should show: none, while the connection is down
/// and the error only says so -- the page already does, once.
export function shownError(text: string | null | undefined, state: ConnectionState): string | null {
  if (!text) return null;
  return state.state === "down" && isReachabilityError(text) ? null : text;
}

/// Registers what a surface re-runs when the connection comes back, for
/// as long as it is open. Returns how to stop.
export function onReconnect(recover: () => void): () => void {
  recoveries.add(recover);
  return () => {
    recoveries.delete(recover);
  };
}

/// The shell said the connection is `next`. Coming back up runs every
/// open surface's recovery, once.
export function connectionChanged(next: ConnectionState): void {
  const was = get(store);
  store.set(next);
  if (was.state !== "down" || next.state !== "up") return;
  for (const recover of [...recoveries]) {
    try {
      recover();
    } catch (e) {
      // One surface failing to re-read must not stop the others.
      console.error("a surface's reconnect threw", e);
    }
  }
}

/// A new visit starts up, with nothing noted. The surfaces' recoveries
/// are theirs to end, as they close.
export function resetReachability(): void {
  store.set(UP);
  unreachable.clear();
}

/// The one line the page shows while the Workstation cannot be reached,
/// or null while it can. Each reason in its own words: they want
/// different things of the human (`hub/live.ts` in the shell).
export function reachabilityLine(state: ConnectionState, workstation: string): string | null {
  if (state.state === "up") return null;
  const name = workstation || "the Workstation";
  switch (state.reason) {
    case "asleep":
      return `${capital(name)} is asleep, or remote access is off there. Trying again…`;
    case "desktop-app-not-running":
      return `Gavin’s desktop app is not answering on ${name}. Trying again…`;
    default:
      return `Can’t reach ${name}. Trying again…`;
  }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
