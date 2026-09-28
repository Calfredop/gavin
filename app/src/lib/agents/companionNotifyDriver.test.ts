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
  it("blocks against a daemon older than v49", () => {
    const compat: DaemonCompat = {
      daemonVersion: 43,
      appVersion: 49,
      degraded: true,
    };
    expect(companionNotifyBlocked(compat)).toMatch(/49/);
  });

  // The Device wire's branch numbered its own bumps 44..48, none of which
  // carries the notification requests: a daemon built there must not be
  // sent them.
  it("blocks against a v48 daemon, which answers with a newer number and lacks the requests", () => {
    const compat: DaemonCompat = {
      daemonVersion: 48,
      appVersion: 49,
      degraded: true,
    };
    expect(companionNotifyBlocked(compat)).toMatch(/49/);
  });

  it("allows a v49 daemon", () => {
    const compat: DaemonCompat = {
      daemonVersion: 49,
      appVersion: 49,
      degraded: false,
    };
    expect(companionNotifyBlocked(compat)).toBeNull();
  });
});
