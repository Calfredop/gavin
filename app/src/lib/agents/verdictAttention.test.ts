import { describe, it, expect, beforeEach, vi } from "vitest";
import { get, writable } from "svelte/store";

import { verdictAttentionStatuses } from "$lib/agents/verdictAttention";
import type { TurnVerdictEntry, TurnReading } from "$lib/agents/turnVerdict";
import type { SessionStatus } from "$lib/core/notifications";

// The store half needs `layoutState`'s `attentionState`, and mocking the
// whole module is how every other suite in this folder reads it. That
// mock is also the reason the store is built lazily rather than at
// module scope -- see the comment on `verdictAttentionState`.
const attentionState = writable<Record<string, unknown>>({
  sessionStatusById: {},
  readSessionIds: new Set<string>(),
});

vi.mock("$lib/core/layoutState", () => ({
  get attentionState() {
    return attentionState;
  },
}));

const read = (reading: TurnReading): TurnVerdictEntry => ({ state: "read", reading });
const asking = read({ kind: "asking" });
const blocked = read({ kind: "blocked", said: "the sandbox refuses the install" });
const finished = read({ kind: "finished" });
const working = read({ kind: "working" });
const pending: TurnVerdictEntry = { state: "pending" };

const verdicts = (entries: Record<string, TurnVerdictEntry>) => new Map(Object.entries(entries));

describe("verdictAttentionStatuses", () => {
  it("raises a quiet session whose verdict read as a prose question", () => {
    // The whole bug: the agent asked in a sentence, rang no bell, and
    // the daemon therefore calls it idle -- which every badge draws as
    // a finished agent with nothing waiting on it.
    const out = verdictAttentionStatuses({ s1: "idle" }, verdicts({ s1: asking }));
    expect(out).toEqual({ s1: "waiting_for_input" });
  });

  it("leaves a blocked turn to the rail that stalls it", () => {
    // `blocked` is reported by verdictStallReason: the rail stalls with
    // the agent's own sentence and pauses. A badge here would be a rule
    // the hub's inbox and the rails' step marks do not share, and
    // attentionInbox already asserts that a blocked verdict lists
    // nothing.
    const statuses: Record<string, SessionStatus> = { s1: "idle" };
    expect(verdictAttentionStatuses(statuses, verdicts({ s1: blocked }))).toBe(statuses);
  });

  it("never rewrites a status the daemon actually observed", () => {
    // The verdict reinterprets QUIET and nothing else. A stale `asking`
    // entry against a session the daemon has since seen move, break or
    // ring its bell must leave that status exactly as it is.
    const statuses: Record<string, SessionStatus> = {
      a: "working",
      b: "failed",
      c: "waiting_for_input",
      d: "unknown",
    };
    const out = verdictAttentionStatuses(
      statuses,
      verdicts({ a: asking, b: asking, c: asking, d: asking })
    );
    expect(out).toBe(statuses);
  });

  it("leaves every other reading alone, pending included", () => {
    const statuses: Record<string, SessionStatus> = { a: "idle", b: "idle", c: "idle" };
    const out = verdictAttentionStatuses(
      statuses,
      verdicts({ a: finished, b: working, c: pending })
    );
    // An unsettled request must not put a badge in front of anybody:
    // pending is not asking (turnVerdict.ts's verdictIsAsking).
    expect(out).toBe(statuses);
  });

  it("skips a session the human has marked as read", () => {
    // Otherwise the mark is undone on the very next store emission, and
    // a verdict-raised badge would have no off switch at all.
    const out = verdictAttentionStatuses(
      { s1: "idle", s2: "idle" },
      verdicts({ s1: asking, s2: asking }),
      new Set(["s1"])
    );
    expect(out).toEqual({ s1: "idle", s2: "waiting_for_input" });
  });

  it("does not put back a bell the mark already masked to idle", () => {
    // `attentionStatuses` has already turned this session's
    // `waiting_for_input` into `idle`. Reading that `idle` and raising
    // it again on a stale asking entry would make "Mark as Read" a
    // no-op for the case it was written for.
    const out = verdictAttentionStatuses(
      { s1: "idle" },
      verdicts({ s1: asking }),
      new Set(["s1"])
    );
    expect(out).toEqual({ s1: "idle" });
  });

  it("hands back the same object when nothing is raised", () => {
    // Identity stability: the derived store feeds four surfaces, and
    // rebuilding the map on every unrelated layout change would
    // invalidate all of them on every keystroke in a terminal.
    const statuses: Record<string, SessionStatus> = { s1: "idle" };
    expect(verdictAttentionStatuses(statuses, new Map())).toBe(statuses);
    expect(verdictAttentionStatuses(statuses, verdicts({ other: asking }))).toBe(statuses);
  });

  it("leaves the sessions it does not raise untouched", () => {
    const out = verdictAttentionStatuses(
      { s1: "idle", s2: "working", s3: "idle" },
      verdicts({ s1: asking })
    );
    expect(out).toEqual({ s1: "waiting_for_input", s2: "working", s3: "idle" });
  });
});

describe("the derived stores", () => {
  beforeEach(async () => {
    const { __resetForTesting } = await import("$lib/agents/verdictAttention");
    __resetForTesting();
    const { __resetForTesting: resetVerdicts } = await import("$lib/agents/turnVerdictState");
    resetVerdicts();
    attentionState.set({ sessionStatusById: {}, readSessionIds: new Set<string>() });
  });

  it("folds the verdict map into the acknowledged layout", async () => {
    const { turnVerdictById } = await import("$lib/agents/turnVerdictState");
    const { verdictAttentionState, verdictAttentionStatusById } = await import(
      "$lib/agents/verdictAttention"
    );
    attentionState.set({
      sessionStatusById: { s1: "idle", s2: "working" },
      readSessionIds: new Set<string>(),
      workspaces: [],
    });
    turnVerdictById.set({ s1: asking });

    expect(get(verdictAttentionStatusById)).toEqual({ s1: "waiting_for_input", s2: "working" });
    // The whole state object, so the pure modules that take one
    // (sidebarSummary, appHub) see the same substitution.
    expect(get(verdictAttentionState).workspaces).toEqual([]);
    expect(get(verdictAttentionState).sessionStatusById).toEqual({
      s1: "waiting_for_input",
      s2: "working",
    });
  });

  it("hands back the layout itself when no verdict raises anything", async () => {
    const { verdictAttentionState } = await import("$lib/agents/verdictAttention");
    const layout = { sessionStatusById: { s1: "idle" }, readSessionIds: new Set<string>() };
    attentionState.set(layout);
    expect(get(verdictAttentionState)).toBe(layout);
  });

  it("survives a layout with no readSessionIds at all", async () => {
    // A state persisted before read marks existed carries none, which
    // layoutState guards with the same `??`. Reading `.has` off
    // undefined here would throw inside every badge on screen.
    const { turnVerdictById } = await import("$lib/agents/turnVerdictState");
    const { verdictAttentionStatusById } = await import("$lib/agents/verdictAttention");
    attentionState.set({ sessionStatusById: { s1: "idle" } });
    turnVerdictById.set({ s1: asking });
    expect(get(verdictAttentionStatusById)).toEqual({ s1: "waiting_for_input" });
  });
});
