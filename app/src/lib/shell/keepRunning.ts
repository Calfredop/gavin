// Keep-running mode, as logic: what closing a window does, and when the
// Mac is held awake.
//
// The Companion drives the running desktop app, not the daemon (ADR
// 0003): the rail scheduler and card launching run in this webview, and
// a phone reaches the host's commands through it. So while remote access
// is on, closing the main window must not put gavin away. It hides the
// window instead, leaving a menu-bar icon that reopens it or quits, and
// the webview -- scheduler and all -- keeps running behind it. HIDES,
// never destroys: a destroyed webview takes its scheduler with it, and a
// hidden one still counts as the window showing its workspaces
// (`railWindowFor` reads the host's window list, which a hidden window is
// still on).
//
// While remote access is off, nothing changes: the main window asks how
// far closing should reach (appClose.ts), and quits.

import type { SessionStatus } from "$lib/core/notifications";

/// What a close request on a window does.
/// - `close`: goes at once, no question. A workspace window: its
///   workspaces return to the window they came from, and nothing stops.
/// - `hide`: the main window leaves the screen and the menu-bar icon
///   appears. Nothing stops, and nothing is asked.
/// - `ask`: the close prompt's ladder, as before keep-running mode.
export type CloseDecision = "close" | "hide" | "ask";

export interface CloseInput {
  /// Whether the window asking is the main one.
  mainWindow: boolean;
  /// The daemon's remote-access switch, or null when this window has not
  /// read it -- a daemon too old to have one, or one that did not
  /// answer.
  remoteAccess: boolean | null;
}

/// Unknown reads as OFF. The ladder is what closing has always done, and
/// a window that hid itself on a guess would leave a human who never
/// turned remote access on looking for an app that did not quit.
export function closeDecision({ mainWindow, remoteAccess }: CloseInput): CloseDecision {
  if (!mainWindow) return "close";
  return remoteAccess === true ? "hide" : "ask";
}

/// The statuses that count as an agent running.
///
/// `working` is a turn in progress. `waiting_for_input` counts too: the
/// agent has stopped on a question, and answering it from the phone is
/// what remote access is for -- a Mac that idle-sleeps under a pending
/// question takes the answer's only route with it. `idle` is a turn that
/// ended, and `failed` and `unknown` are nothing to stay awake for.
const RUNNING: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["working", "waiting_for_input"]);

/// Whether any AGENT session is mid-run. `agentSessionIds` is the set the
/// memory poll keeps (every session the daemon holds that carries a
/// command), so a plain shell left busy -- a dev server, a `tail -f` --
/// never holds the Mac awake.
export function agentRunning(
  agentSessionIds: Iterable<string>,
  statusById: Readonly<Record<string, SessionStatus | undefined>>
): boolean {
  for (const id of agentSessionIds) {
    const status = statusById[id];
    if (status && RUNNING.has(status)) return true;
  }
  return false;
}

/// How long the hold outlives the last running agent.
///
/// An agent's status goes `idle` between one rail step and the next, and
/// the launch queue spaces launches 20 s apart (launchGate.ts). A Mac the
/// human left alone longer than its sleep setting is asleep moments after
/// a hold is let go, so releasing on the first quiet status would put it
/// to sleep in the gap between two steps -- mid-rail, which is the one
/// thing this hold is for. Two minutes covers a step boundary and a
/// queued launch with room to spare, and is still nothing against a Mac
/// left awake all night.
export const SLEEP_HOLD_LINGER_MS = 2 * 60_000;

/// What the idle-sleep hold should do now.
/// - `hold`: remote access is on and an agent is running.
/// - `linger`: remote access is on and no agent is running -- let the
///   hold go once `SLEEP_HOLD_LINGER_MS` passes with none starting.
/// - `release`: remote access is off (or unknown). At once: turning it
///   off is the human saying the phone no longer needs this Mac, and a
///   desk that never held the Mac awake before must not start to.
///
/// Either condition alone is not enough to hold. Remote access with
/// nothing running would keep an idle Mac up all night; an agent running
/// with remote access off is the desk's business.
///
/// Idle sleep only. The display still sleeps, and a lid closed or a
/// Sleep chosen from the Apple menu still sleeps the Mac: those are a
/// human's decisions, and this overrides none of them.
export type SleepHoldAction = "hold" | "linger" | "release";

export function sleepHoldAction(remoteAccess: boolean | null, running: boolean): SleepHoldAction {
  if (remoteAccess !== true) return "release";
  return running ? "hold" : "linger";
}
