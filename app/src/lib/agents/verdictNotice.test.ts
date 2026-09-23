import { describe, it, expect, vi } from "vitest";

// verdictNotice.ts reuses `failureBody` from notifications.ts, which
// imports the two Tauri plugins at module scope. Neither is called by
// anything under test here -- `failureBody` is a pure string function --
// but the modules still have to resolve under node.
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import { verdictHoldsNotification, verdictNotice } from "$lib/agents/verdictNotice";
import type { TurnReading, TurnVerdictEntry } from "$lib/agents/turnVerdict";

const LABEL = "my-project";

const read = (reading: TurnReading | null): TurnVerdictEntry => ({ state: "read", reading });
const PENDING: TurnVerdictEntry = { state: "pending" };

describe("verdictHoldsNotification", () => {
  it("holds the one transition that would say `finished`", () => {
    expect(verdictHoldsNotification("working", "idle", PENDING)).toBe(true);
  });

  it("lets a session nobody asked about notify exactly as it does today", () => {
    // Feature off, no key, an older daemon, a bare terminal, a command
    // tool: all of them are "no entry", and all of them have to reach
    // the tray at the moment of the transition, not three seconds late.
    expect(verdictHoldsNotification("working", "idle", undefined)).toBe(false);
    expect(verdictHoldsNotification("working", "idle", null)).toBe(false);
  });

  it("does not hold a verdict that has already settled", () => {
    // Nothing left to wait for. The reading is read on this tick and
    // the notification goes out with it.
    expect(verdictHoldsNotification("working", "idle", read(null))).toBe(false);
    expect(verdictHoldsNotification("working", "idle", read({ kind: "asking" }))).toBe(false);
  });

  it("holds nothing that was not going to say `finished` anyway", () => {
    // The daemon's own two notification-worthy transitions are not the
    // verdict's business: `waiting_for_input` rang a bell and `failed`
    // carries the agent's own sentence already. Holding either would be
    // the verdict overruling something the daemon OBSERVED -- the rule
    // `verdictAsksQuietly` states for the badges, applied to the tray.
    expect(verdictHoldsNotification("working", "waiting_for_input", PENDING)).toBe(false);
    expect(verdictHoldsNotification("working", "failed", PENDING)).toBe(false);
    expect(verdictHoldsNotification("idle", "working", PENDING)).toBe(false);
  });

  it("holds nothing when the session was not working before", () => {
    // `waiting_for_input -> idle` notifies nothing today, so there is no
    // notification to hold: deferring it would INVENT one for a
    // transition that has always been silent.
    expect(verdictHoldsNotification("waiting_for_input", "idle", PENDING)).toBe(false);
    expect(verdictHoldsNotification(undefined, "idle", PENDING)).toBe(false);
    expect(verdictHoldsNotification("failed", "idle", PENDING)).toBe(false);
  });
});

describe("verdictNotice", () => {
  it("turns a prose question into the needs-input notification", () => {
    // The whole bug: an agent that asks in a sentence rings no bell, so
    // the daemon calls the turn `idle` and today's tray says the exact
    // opposite of what happened.
    expect(verdictNotice(LABEL, read({ kind: "asking" }))).toEqual({
      toggle: "needsInput",
      body: "my-project needs your input",
    });
  });

  it("turns a broken turn into the failure notification, quoting the screen", () => {
    expect(
      verdictNotice(LABEL, read({ kind: "failed", cause: "network", said: "API Error: no route to host" }))
    ).toEqual({
      toggle: "finished",
      body: "my-project stopped — API Error: no route to host",
    });
  });

  it("still says something true about a broken turn it could not read", () => {
    expect(verdictNotice(LABEL, read({ kind: "failed", cause: "unknown", said: "" }))?.body).toBe(
      "my-project stopped: its agent did not finish"
    );
  });

  it("says a blocked agent stopped short, in the agent's own words", () => {
    expect(verdictNotice(LABEL, read({ kind: "blocked", said: "I need the DB credentials" }))).toEqual({
      toggle: "finished",
      body: "my-project: the agent stopped without finishing — I need the DB credentials",
    });
  });

  it("says so when a blocked agent's reason could not be read", () => {
    expect(verdictNotice(LABEL, read({ kind: "blocked", said: "" }))?.body).toBe(
      "my-project: the agent stopped without finishing, and gavin could not read its reason off the screen"
    );
  });

  it("says nothing at all for a turn the verdict reads as still moving", () => {
    // Not a silenced notification but a postponed one: the session is
    // still going, and the next quiet transition gets its own verdict.
    expect(verdictNotice(LABEL, read({ kind: "working" }))).toBeNull();
  });

  it("is exactly today's line for a finished turn", () => {
    expect(verdictNotice(LABEL, read({ kind: "finished" }))).toEqual({
      toggle: "finished",
      body: "my-project finished",
    });
  });

  it("is exactly today's line when the verdict had no opinion", () => {
    // A timeout, an error, a refused key and a reading under the
    // confidence floor all arrive as one of these, and all of them mean
    // today's answer -- just late. That equivalence is what stops a
    // broken key from silencing the tray.
    expect(verdictNotice(LABEL, read(null))?.body).toBe("my-project finished");
    expect(verdictNotice(LABEL, undefined)?.body).toBe("my-project finished");
    expect(verdictNotice(LABEL, null)?.body).toBe("my-project finished");
  });

  it("is today's line for an entry still pending, because a hold has to end", () => {
    // Only reachable if the fallback timer beat a request that never
    // settled. Today's answer is the one safe thing to say about a turn
    // nobody judged.
    expect(verdictNotice(LABEL, PENDING)?.body).toBe("my-project finished");
  });
});
