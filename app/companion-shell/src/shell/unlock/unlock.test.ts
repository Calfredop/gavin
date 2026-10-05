// The Unlock's lifecycle (ADR 0004; ticket 02's "Brief interruptions"):
// what asks, what connects, what ends it and what does not.
import { describe, expect, it } from "vitest";
import {
  connectionsAllowed,
  INITIAL_UNLOCK,
  LAPSE_GRACE_MS,
  stepUnlock,
  unlockNotice,
  type UnlockAction,
  type UnlockEvent,
  type UnlockState,
} from "$shell/unlock/unlock";

const PAIRED = { paired: true, now: 1_000 };

/// Runs `events` from `from`, and returns where it ends and every action
/// taken on the way.
function run(events: UnlockEvent[], from: UnlockState = INITIAL_UNLOCK, context = PAIRED) {
  let state = from;
  const actions: UnlockAction[] = [];
  for (const event of events) {
    const step = stepUnlock(state, event, context);
    state = step.state;
    actions.push(...step.actions);
  }
  return { state, actions };
}

const UNLOCKED = run([{ type: "foreground" }, { type: "prompt-succeeded" }]).state;

describe("the Unlock", () => {
  it("asks once when the Companion comes to the front, and connects every Workstation on one authentication", () => {
    const opened = run([{ type: "foreground" }]);
    expect(opened.state).toEqual({ state: "unlocking", renewing: false });
    expect(opened.actions).toEqual(["prompt"]);

    const unlocked = run([{ type: "prompt-succeeded" }], opened.state);
    expect(unlocked.state).toEqual({ state: "unlocked", since: 1_000 });
    expect(unlocked.actions).toEqual(["connect"]);
    expect(connectionsAllowed(unlocked.state)).toBe(true);
  });

  it("does not ask when nothing is paired: the Demo needs no Unlock", () => {
    expect(run([{ type: "foreground" }], INITIAL_UNLOCK, { paired: false, now: 0 })).toEqual({
      state: INITIAL_UNLOCK,
      actions: [],
    });
    expect(unlockNotice(INITIAL_UNLOCK, false)).toBeNull();
  });

  it("ends when the app goes to the background, dropping every connection", () => {
    const ended = run([{ type: "background" }], UNLOCKED);
    expect(ended.state).toEqual({ state: "locked", why: "background" });
    expect(ended.actions).toEqual(["disconnect"]);
    expect(connectionsAllowed(ended.state)).toBe(false);
  });

  it("ends when the phone locks", () => {
    const ended = run([{ type: "screen-locked" }], UNLOCKED);
    expect(ended.state).toEqual({ state: "locked", why: "screen-locked" });
    expect(ended.actions).toEqual(["disconnect"]);
  });

  it("is not ended by Control Center, the notification shade or a call banner", () => {
    const kept = run([{ type: "interrupted" }, { type: "interrupted" }, { type: "interrupted" }], UNLOCKED);
    expect(kept).toEqual({ state: UNLOCKED, actions: [] });
  });

  it("asks again after every return from the background", () => {
    const back = run([{ type: "background" }, { type: "foreground" }], UNLOCKED);
    expect(back.state).toEqual({ state: "unlocking", renewing: false });
    expect(back.actions).toEqual(["disconnect", "prompt"]);
  });

  it("does not believe the app's lifecycle while its own prompt is up, but does believe the phone locking", () => {
    const asking = run([{ type: "foreground" }]).state;
    // Older Android's passcode screen is an activity of its own: ours stops.
    expect(run([{ type: "background" }], asking)).toEqual({ state: asking, actions: [] });
    expect(run([{ type: "background" }, { type: "prompt-succeeded" }], asking).state).toEqual(UNLOCKED);

    const locked = run([{ type: "screen-locked" }], asking);
    expect(locked.state).toEqual({ state: "locked", why: "screen-locked" });
    // ...and a prompt that answers after that counts for nothing.
    expect(run([{ type: "prompt-succeeded" }], locked.state)).toEqual({ state: locked.state, actions: [] });
  });

  it("stays locked, with a way to ask again, when the owner dismisses the prompt", () => {
    const declined = run([{ type: "foreground" }, { type: "prompt-declined" }]);
    expect(declined.state).toEqual({ state: "locked", why: "declined" });
    expect(unlockNotice(declined.state, true)).toEqual({
      text: "Locked. Unlock to connect to your Workstations.",
      action: true,
    });
    expect(run([{ type: "unlock-requested" }], declined.state).actions).toEqual(["prompt"]);
  });

  it("says why when the prompt fails", () => {
    const failed = run([{ type: "foreground" }, { type: "prompt-failed", problem: "this phone holds no Device keys" }]);
    expect(failed.state).toEqual({ state: "locked", why: "failed", problem: "this phone holds no Device keys" });
    expect(unlockNotice(failed.state, true)?.text).toContain("this phone holds no Device keys");
  });

  it("never asks for a reconnect: a dropped connection is not an Unlock event", () => {
    // What there is to ask about while unlocked, short of leaving the
    // front, the phone locking, or a new connection being refused.
    for (const event of [{ type: "foreground" }, { type: "unlock-requested" }, { type: "interrupted" }] as UnlockEvent[]) {
      expect(stepUnlock(UNLOCKED, event, PAIRED)).toEqual({ state: UNLOCKED, actions: [] });
    }
  });

  it("asks again when Android's auth window closes, keeping the connections already open", () => {
    const later = { paired: true, now: 1_000 + 3_600_000 };
    const renewing = run([{ type: "lapsed" }], UNLOCKED, later);
    expect(renewing.state).toEqual({ state: "unlocking", renewing: true });
    expect(renewing.actions).toEqual(["prompt"]);
    expect(connectionsAllowed(renewing.state)).toBe(true);

    expect(run([{ type: "prompt-succeeded" }], renewing.state, later)).toEqual({
      state: { state: "unlocked", since: later.now },
      actions: ["connect"],
    });
    // Declined, it locks like any other Unlock: everything drops.
    expect(run([{ type: "prompt-declined" }], renewing.state)).toEqual({
      state: { state: "locked", why: "declined" },
      actions: ["disconnect"],
    });
    // A second connection lapsing while it asks asks nothing more.
    expect(run([{ type: "lapsed" }], renewing.state)).toEqual({ state: renewing.state, actions: [] });
  });

  it("locks, saying why, when the hardware refuses straight after the owner confirmed, rather than asking forever", () => {
    const soon = { paired: true, now: 1_000 + LAPSE_GRACE_MS - 1 };
    const refused = run([{ type: "lapsed" }], UNLOCKED, soon);
    expect(refused.state).toMatchObject({ state: "locked", why: "failed" });
    expect(refused.actions).toEqual(["disconnect"]);
    expect(unlockNotice(refused.state, true)?.text).toContain("would not sign");
  });

  it("locks when the native side no longer holds it", () => {
    expect(run([{ type: "not-held" }], UNLOCKED)).toEqual({
      state: { state: "locked", why: "ended" },
      actions: ["disconnect"],
    });
  });

  it("ignores a prompt's answer that arrives with no prompt up", () => {
    for (const event of [
      { type: "prompt-succeeded" },
      { type: "prompt-declined" },
      { type: "prompt-failed", problem: "x" },
    ] as UnlockEvent[]) {
      expect(stepUnlock(INITIAL_UNLOCK, event, PAIRED)).toEqual({ state: INITIAL_UNLOCK, actions: [] });
      expect(stepUnlock(UNLOCKED, event, PAIRED)).toEqual({ state: UNLOCKED, actions: [] });
    }
  });

  it("drops nothing twice: a background while locked records why and does nothing", () => {
    const declined = run([{ type: "foreground" }, { type: "prompt-declined" }]).state;
    expect(run([{ type: "background" }], declined)).toEqual({
      state: { state: "locked", why: "background" },
      actions: [],
    });
  });

  it("tells the hub what to show", () => {
    expect(unlockNotice(UNLOCKED, true)).toBeNull();
    expect(unlockNotice({ state: "unlocking", renewing: false }, true)).toEqual({
      text: "Confirm it’s you to connect to your Workstations.",
      action: false,
    });
    expect(unlockNotice({ state: "locked", why: "background" }, true)?.action).toBe(true);
  });
});
