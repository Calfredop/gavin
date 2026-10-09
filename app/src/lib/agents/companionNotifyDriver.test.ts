import { describe, it, expect } from "vitest";
import {
  companionNotifyBlocked,
  eventsFromAttention,
  notifyWanted,
} from "$lib/agents/companionNotifyDriver";
import type { AttentionItem } from "$lib/companion/attentionAnswer";
import type { DaemonCompat } from "$lib/core/daemonCompat";
import type { DeviceList } from "$lib/core/remoteAccess";

function item(id: string, text = `${id} text`): AttentionItem {
  return { id, workspace: "ws", kind: "waiting", text, target: { kind: "session", id } };
}

describe("eventsFromAttention", () => {
  it("emits notify and resolve events spelled as protocol::CompanionNotifyEvent", () => {
    const events = eventsFromAttention([item("a"), item("b")], [item("a", "changed"), item("c")]);
    expect(events).toEqual([
      {
        op: "notify",
        id: "a",
        kind: "waiting",
        text: "changed",
        workspace_id: "ws",
        target: { type: "session", session_id: "a" },
      },
      {
        op: "notify",
        id: "c",
        kind: "waiting",
        text: "c text",
        workspace_id: "ws",
        target: { type: "session", session_id: "c" },
      },
      { op: "resolve", id: "b" },
    ]);
  });

  it("points a card's item at the card", () => {
    const test: AttentionItem = {
      id: "human-test:plans/a.md:3",
      workspace: "ws",
      kind: "human-test",
      text: "Check it",
      target: { kind: "card", path: "plans/a.md" },
    };
    expect(eventsFromAttention([], [test])).toEqual([
      {
        op: "notify",
        id: "human-test:plans/a.md:3",
        kind: "human-test",
        text: "Check it",
        workspace_id: "ws",
        target: { type: "card", path: "plans/a.md" },
      },
    ]);
  });

  it("notifies nothing of what already waited when the desk opened", () => {
    expect(eventsFromAttention(null, [item("a"), item("b")])).toEqual([]);
  });

  it("stays quiet when nothing changed", () => {
    expect(eventsFromAttention([item("a")], [item("a")])).toEqual([]);
  });
});

describe("notifyWanted", () => {
  const list = (over: Partial<DeviceList>): DeviceList => ({
    devices: [],
    remoteAccessEnabled: true,
    relayUrl: "wss://relay.example",
    relayAdmissionSet: false,
    pushGatewayUrl: "https://push.example",
    ...over,
  });

  it("wants remote access on and a gateway to post to", () => {
    expect(notifyWanted(list({}))).toBe(true);
    expect(notifyWanted(list({ remoteAccessEnabled: false }))).toBe(false);
    expect(notifyWanted(list({ pushGatewayUrl: null }))).toBe(false);
    expect(notifyWanted(list({ pushGatewayUrl: undefined }))).toBe(false);
    expect(notifyWanted(null)).toBe(false);
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

  // Before its renumber, the Device wire's branch numbered its own bumps
  // 44..48, none of which carries the notification requests: a daemon
  // built there must not be sent them.
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
