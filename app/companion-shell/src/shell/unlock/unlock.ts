// The Unlock (ADR 0004): one Face ID, fingerprint or passcode, when the
// Companion comes to the front, unlocks the connections to every paired
// Workstation, until the app goes to the background or the phone locks.
//
// This is the rule, as a pure step from one state to the next. The native
// side holds the authentication itself (the `LAContext` on iOS, the
// hardware key's auth window on Android) and ends it on background and
// lock without waiting for this layer (`native/deviceKeys.ts`); this
// module decides what the shell does about it: when to ask, when to
// connect, when to drop every connection.
//
// What ends it, and what does not, is ticket 02's finding
// (`docs/research/2026-09-28-companion-device-keys.md`, "Brief
// interruptions"):
//
// - **Ends it:** the app going to the background (Home, the app switcher,
//   another app, answering a call) and the phone locking.
// - **Does not:** Control Center, the notification shade, a call banner,
//   the Unlock's own prompt. They are `interrupted` here, and change
//   nothing. On iOS the shade does send the app to the background, for as
//   long as it is down; the native side does not report a background that
//   is over within two seconds, so a glance at it never reaches this layer.
// - **While the prompt is up**, the app's lifecycle is not believed: on
//   older Android the passcode screen is an activity of its own, which
//   stops ours. A prompt the owner really walked away from is cancelled by
//   the system, and that is what ends it.
// - **A reconnect never asks.** A dropped connection is not an event here
//   at all: it signs under the Unlock that is held.
// - **The one exception is Android's auth window** (ADR 0004): once it
//   closes, a new connection asks again (`lapsed`), and the connections
//   already open stay open while it does. A lapse straight after the
//   owner confirmed is not that: the hardware is refusing under a fresh
//   authentication, and asking again would only ask forever. It locks,
//   and says so.

export type LockedWhy =
  /// The app has not been in front with anything to unlock yet.
  | "not-yet"
  | "background"
  | "screen-locked"
  /// The owner dismissed the prompt.
  | "declined"
  /// The prompt, or the keys behind it, failed. `problem` says how.
  | "failed"
  /// The native side holds no Unlock any more, and this layer had not
  /// heard why yet.
  | "ended";

export type UnlockState =
  | { state: "locked"; why: LockedWhy; problem?: string }
  /// The prompt is on screen. `renewing`: an Unlock lapsed while
  /// connections stayed open, and it is being asked for again.
  | { state: "unlocking"; renewing: boolean }
  /// `since`: when the owner last confirmed, by the context's clock.
  | { state: "unlocked"; since: number };

export type UnlockEvent =
  /// The app came to the front: at launch, and back from the background.
  | { type: "foreground" }
  | { type: "background" }
  | { type: "screen-locked" }
  /// Control Center, the shade, a call banner, a system sheet: the app
  /// lost the focus without leaving the front.
  | { type: "interrupted" }
  /// The human asked, from the hub.
  | { type: "unlock-requested" }
  | { type: "prompt-succeeded" }
  | { type: "prompt-declined" }
  | { type: "prompt-failed"; problem: string }
  /// A new connection could not be signed: the Unlock no longer covers it.
  | { type: "lapsed" }
  /// A new connection could not be signed: no Unlock is held natively.
  | { type: "not-held" };

/// What the shell does, in order.
export type UnlockAction =
  /// Ask the owner (`DeviceKeys.unlock`).
  | "prompt"
  /// Connect every paired Workstation that is not connected.
  | "connect"
  /// Try every Workstation now, rather than when its backoff says: the
  /// owner is looking.
  | "refresh"
  /// Drop every connection, and end the native Unlock if it is held.
  | "disconnect";

export interface UnlockStep {
  state: UnlockState;
  actions: UnlockAction[];
}

export interface UnlockContext {
  /// Whether any Workstation is paired: with none there is nothing to
  /// unlock, and the owner is not asked.
  paired: boolean;
  /// Milliseconds, on any clock that only moves forward.
  now: number;
}

/// A lapse this soon after the owner confirmed is the hardware refusing a
/// fresh authentication, not the auth window closing (an hour, ticket
/// 02's recommendation).
export const LAPSE_GRACE_MS = 60_000;

const REFUSED_AFTER_UNLOCK = "this phone would not sign a connection even straight after you confirmed it’s you";

export const INITIAL_UNLOCK: UnlockState = { state: "locked", why: "not-yet" };

export function stepUnlock(state: UnlockState, event: UnlockEvent, context: UnlockContext): UnlockStep {
  const stay: UnlockStep = { state, actions: [] };
  const lock = (why: LockedWhy, problem?: string): UnlockStep => ({
    state: problem === undefined ? { state: "locked", why } : { state: "locked", why, problem },
    actions: state.state === "locked" ? [] : ["disconnect"],
  });
  const ask = (renewing: boolean): UnlockStep =>
    context.paired ? { state: { state: "unlocking", renewing }, actions: ["prompt"] } : stay;

  switch (event.type) {
    case "interrupted":
      return stay;

    case "foreground":
      // Launch, or back from the background: each foreground stretch
      // asks once, and a fresh Unlock connects everything at once. Back
      // with one still held, nothing is asked, but what was waiting out
      // a backoff is tried now: the owner is looking at it.
      if (state.state === "locked") return ask(false);
      return state.state === "unlocked" ? { state, actions: ["refresh"] } : stay;

    case "unlock-requested":
      return state.state === "locked" ? ask(false) : stay;

    case "background":
    case "screen-locked": {
      const why = event.type;
      // The prompt's own lifecycle is not believed; the system cancels a
      // prompt the owner really left, and that ends it. The phone
      // locking is believed always.
      if (state.state === "unlocking" && why === "background") return stay;
      if (state.state === "locked") return { state: { state: "locked", why }, actions: [] };
      return lock(why);
    }

    case "prompt-succeeded":
      // A prompt that answers after the Unlock was already ended -- the
      // phone locked while it was up -- counts for nothing.
      return state.state === "unlocking"
        ? { state: { state: "unlocked", since: context.now }, actions: ["connect"] }
        : stay;

    case "prompt-declined":
      return state.state === "unlocking" ? lock("declined") : stay;

    case "prompt-failed":
      return state.state === "unlocking" ? lock("failed", event.problem) : stay;

    case "lapsed":
      if (state.state !== "unlocked") return stay;
      if (context.now - state.since < LAPSE_GRACE_MS) return lock("failed", REFUSED_AFTER_UNLOCK);
      // Asked again, and nothing dropped while it is: the connections
      // already open were made under an Unlock that was good.
      return ask(true);

    case "not-held":
      return state.state === "unlocked" ? lock("ended") : stay;
  }
}

/// Whether connections may be made and kept: unlocked, or asking again
/// while those already open stay.
export function connectionsAllowed(state: UnlockState): boolean {
  return state.state === "unlocked" || (state.state === "unlocking" && state.renewing);
}

/// What the owner's prompt says.
export const UNLOCK_REASON = "Unlock your Workstations";

/// The hub's line about the Unlock, or null when there is nothing to say.
export function unlockNotice(state: UnlockState, paired: boolean): { text: string; action: boolean } | null {
  if (!paired) return null;
  switch (state.state) {
    case "unlocked":
      return null;
    case "unlocking":
      return { text: "Confirm it’s you to connect to your Workstations.", action: false };
    case "locked":
      switch (state.why) {
        case "declined":
          return { text: "Locked. Unlock to connect to your Workstations.", action: true };
        case "failed":
          return { text: `Locked: ${state.problem ?? "the phone could not confirm it’s you"}`, action: true };
        default:
          return { text: "Locked. Unlock to connect to your Workstations.", action: true };
      }
  }
}
