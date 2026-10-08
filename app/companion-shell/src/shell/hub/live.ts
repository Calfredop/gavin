// What the hub knows about each paired Workstation while the Companion is
// unlocked: whether it can be reached, and what it answered (spec, "The
// Workstations hub": ready, desktop app not running, or asleep).
import type { AttentionItem, DesktopReason } from "$shell/connection/attention";

export type LiveState =
  /// No Unlock: nothing is connected.
  | { state: "locked" }
  | { state: "connecting" }
  /// Connected, and its desktop app answered what is waiting.
  | { state: "ready"; items: AttentionItem[] }
  /// Connected, and nothing answers there: the desktop app is not
  /// running, or not answering -- `reason` says which, when the
  /// Workstation is new enough to (ADR 0003).
  | { state: "desktop-app-not-running"; reason?: DesktopReason }
  /// Its Relay holds no Workstation under its key: the Mac is asleep, or
  /// remote access is off at the desk.
  | { state: "asleep" }
  /// No Relay carried the connection, or it dropped.
  | { state: "unreachable"; problem: string }
  /// The Workstation will not connect with this Device until it pairs
  /// again: revoked, removed, or unseen too long.
  | { state: "refused"; problem: string }
  /// Something on this phone failed: its keys, or the Companion core.
  | { state: "failed"; problem: string };

export type LiveStateName = LiveState["state"];

/// A dropped connection is tried again after `floorMs`, doubling to
/// `ceilingMs`. A connection held for `settledMs` starts the count over:
/// one that is accepted and dropped at once is still failing. The daemon
/// paces its own dial to the Relay the same way (`remote.rs`).
export const RECONNECT = { floorMs: 1_000, ceilingMs: 30_000, settledMs: 30_000 };

/// How long to wait before the `failures`-th attempt in a row (1 is the
/// first retry).
export function reconnectDelay(failures: number, policy = RECONNECT): number {
  const exponent = Math.max(0, Math.min(failures - 1, 30));
  return Math.min(policy.ceilingMs, policy.floorMs * 2 ** exponent);
}

/// How often a connected Workstation is asked again what is waiting. The
/// answer comes from what its desktop app already holds, so asking is
/// cheap; it is also what finds a connection a dead network left open.
export const ATTENTION_POLL_MS = 15_000;

export function liveLabel(live: LiveState): string {
  switch (live.state) {
    case "locked":
      return "Locked";
    case "connecting":
      return "Connecting…";
    case "ready":
      return "Ready";
    case "desktop-app-not-running":
      switch (live.reason) {
        case "not-answering":
          return "Desktop app not answering";
        case "connection-lost":
          return "Desktop app disconnected";
        default:
          return "Desktop app not running";
      }
    case "asleep":
      return "Asleep";
    case "unreachable":
      return "Unreachable";
    case "refused":
      return "Pair again";
    case "failed":
      return "Can’t connect";
  }
}

/// The line under a Workstation's name.
export function liveSummary(live: LiveState): string {
  switch (live.state) {
    case "locked":
      return "Unlock to connect.";
    case "connecting":
      return "Connecting through its Relay.";
    case "ready":
      return live.items.length === 0
        ? "Nothing is waiting on you."
        : `${live.items.length} waiting on you.`;
    case "desktop-app-not-running":
      // What to do, not only what is wrong: the three want different
      // things of the human at the desk.
      switch (live.reason) {
        case "not-answering":
          return "Gavin’s desktop app is open there but did not answer in time. If this lasts, quit and reopen it at the desk.";
        case "connection-lost":
          return "Gavin’s desktop app dropped its connection while answering. If it is still open, it reconnects on its own.";
        default:
          return "It is on, but Gavin’s desktop app is not running there. Open Gavin at the desk.";
      }
    case "asleep":
      return "Its Relay has not heard from it: it is asleep, or remote access is off at the desk.";
    case "unreachable":
    case "refused":
    case "failed":
      return live.problem;
  }
}
