// What a visit's bundle is told of its Workstation's connection
// (the channel's `connection` message): up, or down and why.
//
// Read from the live hub's state for that Workstation and whether it
// holds a connection to it. Up means the desktop app there answered: a
// connection that reaches only the daemon (`desktop-app-not-running`)
// carries no call the bundle makes, so to the bundle it is down.
import type { ConnectionState } from "$companion/channel/messages";
import type { LiveState } from "$shell/hub/live";

export const UP: ConnectionState = { state: "up" };

/// The state to tell the bundle. `live` is null where the hub's state is
/// not known -- a source that only hands out connections -- and the
/// connection alone decides. `previous` is what the bundle was told last:
/// a reconnect passes through `connecting` on every attempt, and those
/// are not news -- a Workstation that is asleep stays asleep between
/// tries, rather than flickering to "unreachable" and back.
export function connectionStateOf(
  live: LiveState | null,
  connected: boolean,
  previous: ConnectionState
): ConnectionState {
  if (live === null) return connected ? UP : { state: "down", reason: "unreachable" };
  switch (live.state) {
    case "ready":
      // Between the connection dropping and the hub saying why, the hub
      // still reads `ready`.
      return connected ? UP : { state: "down", reason: "unreachable" };
    case "desktop-app-not-running":
      return { state: "down", reason: "desktop-app-not-running" };
    case "asleep":
      return { state: "down", reason: "asleep" };
    case "connecting":
      return previous.state === "down" ? previous : connected ? UP : { state: "down", reason: "unreachable" };
    case "unreachable":
    case "refused":
    case "failed":
    case "locked":
      return { state: "down", reason: "unreachable" };
  }
}

export function sameConnectionState(a: ConnectionState, b: ConnectionState): boolean {
  return a.state === b.state && (a.state === "up" || (b.state === "down" && a.reason === b.reason));
}
