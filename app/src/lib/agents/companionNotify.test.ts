import { describe, it, expect } from "vitest";
import {
  companionNotifyDiff,
  companionWaitingFromSignals,
  type CompanionWaitingItem,
} from "$lib/agents/companionNotify";

function item(
  id: string,
  overrides: Partial<CompanionWaitingItem> = {},
): CompanionWaitingItem {
  return {
    id,
    workspaceId: "ws-1",
    kind: "asking",
    text: `${id} needs you`,
    target: { type: "session", sessionId: `sess-${id}` },
    ...overrides,
  };
}

describe("companionNotifyDiff", () => {
  it("notifies every newly waiting item", () => {
    const a = item("a");
    const b = item("b", { kind: "failed", text: "b failed" });
    expect(companionNotifyDiff([], [a, b])).toEqual({
      notify: [a, b],
      resolve: [],
    });
  });

  it("resolves an item that left the waiting set", () => {
    const a = item("a");
    const b = item("b");
    expect(companionNotifyDiff([a, b], [a])).toEqual({
      notify: [],
      resolve: ["b"],
    });
  });

  it("re-notifies when the same id's text or kind changes", () => {
    const before = item("a", { text: "which migration?" });
    const after = item("a", { text: "which branch?", kind: "asking" });
    expect(companionNotifyDiff([before], [after])).toEqual({
      notify: [after],
      resolve: [],
    });
  });

  it("stays quiet when the waiting set is unchanged", () => {
    const a = item("a");
    const b = item("b", { kind: "rail-stopped", text: "rail X finished" });
    expect(companionNotifyDiff([a, b], [a, b])).toEqual({
      notify: [],
      resolve: [],
    });
  });

  it("notifies arrivals and resolves departures in one pass", () => {
    const kept = item("kept");
    const gone = item("gone");
    const arrived = item("arrived", { kind: "human-test", text: "check the lock screen" });
    expect(companionNotifyDiff([kept, gone], [kept, arrived])).toEqual({
      notify: [arrived],
      resolve: ["gone"],
    });
  });
});

describe("companionWaitingFromSignals", () => {
  it("builds asking, failed and interrupted rows from the attention inbox", () => {
    const items = companionWaitingFromSignals({
      attention: [
        {
          sessionId: "s1",
          workspaceId: "ws",
          reason: "asking",
          cardTitle: "feat-x",
          failureReason: null,
        },
        {
          sessionId: "s2",
          workspaceId: "ws",
          reason: "failed",
          cardTitle: null,
          failureReason: "exit 1",
        },
        {
          sessionId: "s3",
          workspaceId: "ws",
          reason: "blocked",
          cardTitle: "feat-y",
          failureReason: "cannot proceed",
        },
      ],
      humanTests: [],
      railStops: [],
    });
    expect(items).toEqual([
      {
        id: "session:s1",
        workspaceId: "ws",
        kind: "asking",
        text: "feat-x: needs your input",
        target: { type: "session", sessionId: "s1" },
      },
      {
        id: "session:s2",
        workspaceId: "ws",
        kind: "failed",
        text: "exit 1",
        target: { type: "session", sessionId: "s2" },
      },
      {
        id: "session:s3",
        workspaceId: "ws",
        kind: "interrupted",
        text: "feat-y: cannot proceed",
        target: { type: "session", sessionId: "s3" },
      },
    ]);
  });

  it("skips attention reasons that are not Companion notify triggers", () => {
    const items = companionWaitingFromSignals({
      attention: [
        {
          sessionId: "s1",
          workspaceId: "ws",
          reason: "turn-ended",
          cardTitle: "feat",
          failureReason: null,
        },
        {
          sessionId: "s2",
          workspaceId: "ws",
          reason: "stale",
          cardTitle: "feat",
          failureReason: null,
        },
        {
          sessionId: "s3",
          workspaceId: "ws",
          reason: "decoy-edit",
          cardTitle: "feat",
          failureReason: null,
        },
      ],
      humanTests: [],
      railStops: [],
    });
    expect(items).toEqual([]);
  });

  it("adds filed human tests and rail stops", () => {
    const items = companionWaitingFromSignals({
      attention: [],
      humanTests: [
        {
          id: "ht-1",
          workspaceId: "ws",
          cardPath: "/ws/.gavin-root/plans/feat.md",
          text: "check the lock screen",
        },
      ],
      railStops: [
        {
          railId: "rail-1",
          workspaceId: "ws",
          text: "ship: failed on stage 2",
          // A rail has no session; the Companion opens the card the rail
          // was placed for, when one is known.
          cardPath: "/ws/.gavin-root/plans/ship.md",
        },
      ],
    });
    expect(items).toEqual([
      {
        id: "human-test:ht-1",
        workspaceId: "ws",
        kind: "human-test",
        text: "check the lock screen",
        target: { type: "card", path: "/ws/.gavin-root/plans/feat.md" },
      },
      {
        id: "rail:rail-1",
        workspaceId: "ws",
        kind: "rail-stopped",
        text: "ship: failed on stage 2",
        target: { type: "card", path: "/ws/.gavin-root/plans/ship.md" },
      },
    ]);
  });
});
