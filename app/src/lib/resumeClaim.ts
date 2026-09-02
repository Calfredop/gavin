// One resume per session, ever, no matter how many callers want one.
//
// Two resumes of one session is its own bug, separate from anything the
// trigger table decides, and gavin has at least three ways to fire one:
//
//  - the automatic resume landing at the same moment the human presses
//    the manual button -- the likeliest of the three, since the
//    notification that prompts the human arrives exactly when the
//    trigger fires;
//  - a card binding and a rail step pointing at one session;
//  - a startup reconciliation pass racing a live trigger.
//
// cmux hit this hard enough to build `AgentResumeLaunchGuard.swift` for
// it (their issue #8446): a TTL'd claim per (agent kind, session id) that
// a caller must win before launching, so "two panels in the same restore
// pass" never both run `claude --resume <id>`. Two of their judgements
// are copied here because both are non-obvious, and both are the
// difference between a guard and a wedge.

/// How long a claim stands before it expires on its own.
///
/// It MUST expire rather than persist. A permanent claim would block a
/// legitimate resume of the same session later, when the agent really
/// has exited -- turning a race guard into a run that can never be
/// recovered. Long enough to cover a launch (a spawn, a rename and two
/// daemon writes); short enough that a caller which died mid-flight
/// stops blocking anything within the minute.
export const CLAIM_TTL_MS = 60_000;

/// The key a claim is taken on: the agent kind and the session being
/// resumed. cmux keys on the pair rather than the session alone, and it
/// costs nothing to do the same -- a session id is unique per daemon, but
/// the pair stays correct if a second agent kind ever shares the
/// namespace.
export function claimKey(agentKind: string, sessionId: string): string {
  return `${agentKind}:${sessionId}`;
}

/// A registry of in-flight resume claims.
///
/// Deliberately in memory and never persisted: a claim describes a launch
/// that is HAPPENING, and nothing is in flight across an app restart. A
/// claim store that survived a restart would be describing a launch that
/// no longer exists, which is the permanent-claim failure again by
/// another route.
export class ResumeClaims {
  private held = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /// Wins the claim, or returns false because somebody else holds it.
  ///
  /// Expiry is checked here rather than swept on a timer: a claim only
  /// matters at the moment another caller asks for it, so the read is the
  /// only place the clock needs consulting.
  tryClaim(key: string, ttlMs: number = CLAIM_TTL_MS): boolean {
    const now = this.now();
    const until = this.held.get(key);
    if (until !== undefined && until > now) return false;
    this.held.set(key, now + ttlMs);
    return true;
  }

  /// Gives a claim back before its TTL runs out.
  ///
  /// For the caller that takes a claim and then FAILS to launch -- the
  /// spawn was refused, the command could not be built, the daemon said
  /// no. Without this the failed attempt would hold the session shut for
  /// the full TTL, and the human's own press would silently do nothing
  /// during exactly the minute they are most likely to try it.
  ///
  /// Not called on success, deliberately: a resume that DID launch should
  /// keep the door shut for the rest of the window, because the duplicate
  /// this guard exists for is a second trigger still in flight.
  release(key: string): void {
    this.held.delete(key);
  }

  /// Whether a claim currently stands. For surfaces that want to explain
  /// a refusal rather than take a claim of their own.
  isHeld(key: string, now: number = this.now()): boolean {
    const until = this.held.get(key);
    return until !== undefined && until > now;
  }

  /// @internal - for testing only
  clear(): void {
    this.held.clear();
  }
}

/// The app's one registry. A module-level singleton because the whole
/// point is that every caller in the process consults the SAME one: a
/// per-component instance would guard nothing.
export const resumeClaims = new ResumeClaims();
