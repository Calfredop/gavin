import { describe, it, expect } from "vitest";
import {
  companionNotifyBlocked,
  eventsFromWaitingSets,
} from "$lib/agents/companionNotifyDriver";
import type { CompanionWaitingItem } from "$lib/agents/companionNotify";
import type { DaemonCompat } from "$lib/core/daemonCompat";

function item(id: string, text = `${id} text`): CompanionWaitingItem {
  return {
    id,
    workspaceId: "ws",
    kind: "asking",
    text,
    target: { type: "session", sessionId: id },
  };
}

describe("eventsFromWaitingSets", () => {
  it("emits notify and resolve events the daemon can seal", () => {
    const events = eventsFromWaitingSets(
      [item("a"), item("b")],
      [item("a", "changed"), item("c")],
    );
    expect(events).toEqual([
      {
        op: "notify",
        id: "a",
        kind: "asking",
        text: "changed",
        workspaceId: "ws",
        target: { type: "session", sessionId: "a" },
      },
      {
        op: "notify",
        id: "c",
        kind: "asking",
        text: "c text",
        workspaceId: "ws",
        target: { type: "session", sessionId: "c" },
      },
      { op: "resolve", id: "b" },
    ]);
  });
});

describe("companionNotifyBlocked", () => {
  it("blocks against a daemon older than v44", () => {
    const compat: DaemonCompat = {
      daemonVersion: 43,
      appVersion: 44,
      degraded: true,
    };
    expect(companionNotifyBlocked(compat)).toMatch(/44/);
  });

  it("allows a v44 daemon", () => {
    const compat: DaemonCompat = {
      daemonVersion: 44,
      appVersion: 44,
      degraded: false,
    };
    expect(companionNotifyBlocked(compat)).toBeNull();
  });
});
