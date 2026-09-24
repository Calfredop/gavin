import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get, writable } from "svelte/store";

// This file's one entry point is a slot it hands to layoutState, so the
// mock captures it: every test below drives the feature exactly as
// `handleSessionStatusChanged` does -- "this session's status changed,
// here is what it was a moment ago" -- and then answers as the verdict
// driver would.
const captured = vi.hoisted(() => ({
  hold: null as
    | ((sessionId: string, previous: string | undefined, status: string) => boolean)
    | null,
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable: w } = await import("svelte/store");
  return {
    layoutState: w({
      sessionStatusById: {} as Record<string, string>,
      sessionNames: {} as Record<string, string>,
      cwdBySessionId: {} as Record<string, string>,
      workspaces: [] as unknown[],
    }),
    // The real one resolves the session's owning workspace; these tests
    // are about WHICH line goes out, and notifications.test.ts covers
    // what each toggle does to it.
    notifyPrefsFor: vi.fn(() => ({ needsInput: true, finished: true })),
    setStatusNoticeHold: vi.fn((hold) => {
      captured.hold = hold;
    }),
  };
});

// The real notifications module, so the assertions below are about what
// actually reaches the tray. Only its two Tauri dependencies are stood
// in for: permission granted, gavin not frontmost -- the state in which
// a notification is supposed to go out.
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ isFocused: vi.fn().mockResolvedValue(false) })),
}));

import { sendNotification } from "@tauri-apps/plugin-notification";
import { layoutState, notifyPrefsFor, setStatusNoticeHold } from "$lib/core/layoutState";
import { PENDING_BACKSTOP_MS, turnVerdictById } from "$lib/agents/turnVerdictState";
import type { TurnReading } from "$lib/agents/turnVerdict";
import {
  VERDICT_NOTICE_WAIT_MS,
  startVerdictNotices,
  __resetForTesting,
} from "$lib/agents/verdictNoticeState";

const state = layoutState as unknown as ReturnType<
  typeof writable<{
    sessionStatusById: Record<string, string>;
    sessionNames: Record<string, string>;
    cwdBySessionId: Record<string, string>;
    workspaces: unknown[];
  }>
>;

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // Explicitly, not just in the factory: `clearAllMocks` forgets calls
  // but keeps implementations, so the one test below that silences a
  // workspace would silence every test after it.
  vi.mocked(notifyPrefsFor).mockReturnValue({ needsInput: true, finished: true });
  __resetForTesting();
  turnVerdictById.set({});
  state.set({ sessionStatusById: {}, sessionNames: {}, cwdBySessionId: {}, workspaces: [] });
  stop = startVerdictNotices();
});

afterEach(() => {
  stop?.();
  stop = null;
});

/// What layoutState does on a quiet transition, in its order: the
/// verdict driver's hook has already marked the session pending, the
/// store has already been updated with the new status, and only then is
/// the hold asked.
function quiet(sessionId = "s-1", previous = "working"): boolean {
  state.update((s) => ({ ...s, sessionStatusById: { ...s.sessionStatusById, [sessionId]: "idle" } }));
  return captured.hold?.(sessionId, previous, "idle") ?? false;
}

function judging(sessionId = "s-1"): void {
  turnVerdictById.set({ [sessionId]: { state: "pending" } });
}

function settles(reading: TurnReading | null, sessionId = "s-1"): void {
  turnVerdictById.set({ [sessionId]: { state: "read", reading } });
}

function body(): string {
  const call = vi.mocked(sendNotification).mock.calls[0][0] as { body: string };
  return call.body;
}

describe("the hold", () => {
  it("takes the notification for a quiet turn the verdict is judging", () => {
    judging();
    expect(quiet()).toBe(true);
    // Taken, not sent: there is nothing true to say yet.
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("declines a session nobody asked about", () => {
    // The feature off, no key, an older daemon, a bare terminal, a
    // command tool: the driver writes no entry for any of them, and
    // layoutState has to notify at the transition exactly as it does
    // today.
    expect(quiet()).toBe(false);
  });

  it("declines when the verdict has already settled", () => {
    settles({ kind: "asking" });
    expect(quiet()).toBe(false);
  });

  it("declines a transition that says nothing today", () => {
    // `waiting_for_input -> idle` notifies nothing, so holding it would
    // invent a notification rather than delay one.
    judging();
    expect(quiet("s-1", "waiting_for_input")).toBe(false);
  });

  it("declines once its teardown has run", () => {
    judging();
    stop?.();
    stop = null;
    expect(setStatusNoticeHold).toHaveBeenLastCalledWith(null);
  });
});

describe("the line a held notification finally sends", () => {
  it("says the agent needs input when the verdict read a prose question", async () => {
    // The whole bug: no bell rang, the daemon called the turn `idle`,
    // and today's tray said the agent had finished.
    judging();
    quiet();
    settles({ kind: "asking" });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(body()).toBe("s-1 needs your input");
  });

  it("says what broke, in the agent's own words, for a turn read as failed", async () => {
    judging();
    quiet();
    settles({ kind: "failed", cause: "network", said: "API Error: Connection reset by peer." });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(body()).toBe("s-1 stopped — API Error: Connection reset by peer.");
  });

  it("says it stopped short, in the agent's own words, for a blocked turn", async () => {
    judging();
    quiet();
    settles({ kind: "blocked", said: "I need the DB credentials to go on" });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(body()).toBe(
      "s-1: the agent stopped without finishing — I need the DB credentials to go on"
    );
  });

  it("says exactly today's line when the verdict had no opinion, just late", async () => {
    // A timeout, a dead socket, a refused key, a reading under the
    // confidence floor: all of them land here, and all of them have to
    // leave the tray saying what it says today.
    judging();
    quiet();
    settles(null);
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(body()).toBe("s-1 finished");
  });

  it("says nothing at all when the verdict read the agent as still moving", async () => {
    judging();
    quiet();
    settles({ kind: "working" });
    // Not a delayed notification but no notification: the turn did not
    // end, and the next quiet transition is judged on its own.
    await vi.waitFor(() => expect(get(turnVerdictById)["s-1"].state).toBe("read"));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("reaches a workspace silenced for endings when the turn turns out to be a question", async () => {
    // Deliberate, and the clearest case of what this card changes. The
    // human said "tell me when an agent needs me, not when one
    // finishes"; the daemon could not tell those two apart and called
    // both `idle`, so today's `notifyFinished` check swallowed the
    // question along with the endings. The verdict can tell them apart.
    judging();
    quiet();
    vi.mocked(notifyPrefsFor).mockReturnValue({ needsInput: true, finished: false });
    settles({ kind: "asking" });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(body()).toBe("s-1 needs your input");
  });

  it("answers to the toggles in force when it sends, not when it was held", async () => {
    // Seconds passed. A workspace the human silenced in the meantime is
    // silenced for this line too.
    judging();
    quiet();
    vi.mocked(notifyPrefsFor).mockReturnValue({ needsInput: true, finished: false });
    settles({ kind: "finished" });
    await vi.waitFor(() => expect(notifyPrefsFor).toHaveBeenCalled());
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("a hold whose turn is already over", () => {
  it("drops the line when the session has started talking again", async () => {
    judging();
    quiet();
    state.update((s) => ({ ...s, sessionStatusById: { "s-1": "working" } }));
    settles({ kind: "asking" });
    await vi.waitFor(() => expect(get(turnVerdictById)["s-1"].state).toBe("read"));
    // A tray line about a question the human has already answered is
    // worse than no line at all.
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("drops the line when the driver cleared the verdict instead of settling it", async () => {
    // What `clearTurnVerdict` does: the row goes, and the settle
    // resolves with undefined -- which reads as today's answer and
    // would otherwise be announced for a session that is no longer
    // quiet.
    judging();
    quiet();
    state.update((s) => ({ ...s, sessionStatusById: { "s-1": "working" } }));
    turnVerdictById.set({});
    await vi.waitFor(() => expect(get(turnVerdictById)["s-1"]).toBeUndefined());
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("lets only the newest hold speak when a session goes quiet twice", async () => {
    judging();
    quiet();
    // Talking again, then quiet again, all inside the first wait.
    state.update((s) => ({ ...s, sessionStatusById: { "s-1": "working" } }));
    judging();
    quiet();
    settles({ kind: "asking" });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
    // One line for the turn, not two.
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("says nothing for a hold still waiting when the window tears down", async () => {
    judging();
    quiet();
    stop?.();
    stop = null;
    settles({ kind: "asking" });
    await vi.waitFor(() => expect(get(turnVerdictById)["s-1"].state).toBe("read"));
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("a verdict that never arrives", () => {
  it("ends the hold by itself and sends today's line", async () => {
    // A hold that never ends is a notification lost, which is strictly
    // worse than one that says the old, duller thing. Three timers
    // stand behind this outcome -- the driver's own backstop,
    // `whenTurnVerdictSettles`'s bound on top of it, and
    // VERDICT_NOTICE_WAIT_MS on top of that -- and the assertion is the
    // outcome rather than which of them fired, because a test that
    // pinned the innermost one would go green on a build where only the
    // outermost still worked.
    vi.useFakeTimers();
    try {
      judging();
      quiet();
      expect(sendNotification).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(VERDICT_NOTICE_WAIT_MS);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(body()).toBe("s-1 finished");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is bounded even if the settle promise is the thing that never resolves", () => {
    // VERDICT_NOTICE_WAIT_MS is the outermost of the three and has to
    // sit BEHIND the one it backs up, or it could never be the thing
    // that ends a wait.
    expect(VERDICT_NOTICE_WAIT_MS).toBeGreaterThan(PENDING_BACKSTOP_MS + 500);
  });
});
