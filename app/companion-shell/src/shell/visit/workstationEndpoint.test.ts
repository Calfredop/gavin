// A paired Workstation's end of the channel, against a scripted
// connection: what each bundle message becomes on the wire, what comes
// back, and what happens when the connection is not there or comes back.
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_VERSION, encode } from "$companion/channel/messages";
import type { Connection } from "$shell/connection/connection";
import { NOT_CONNECTED, problemOf, workstationEndpoint, type ConnectionSource } from "$shell/visit/workstationEndpoint";

/// A connection whose answers are scripted by request type, and whose
/// pushes the test sends.
function scripted() {
  const sent: Array<Record<string, unknown>> = [];
  const answers = new Map<string, (message: Record<string, unknown>) => unknown>();
  const pushHandlers = new Set<(m: unknown) => void>();
  const connection: Connection = {
    request: vi.fn(async (message: unknown) => {
      const m = message as Record<string, unknown>;
      sent.push(m);
      const answer = answers.get(m.type as string);
      if (!answer) throw new Error(`no script for ${m.type}`);
      return answer(m);
    }),
    onPush: (handler) => {
      pushHandlers.add(handler);
      return () => pushHandlers.delete(handler);
    },
    close: () => {},
    closed: new Promise<string>(() => {}),
    isClosed: false,
  };
  return {
    connection,
    sent,
    answers,
    push: (m: unknown) => {
      for (const h of pushHandlers) h(m);
    },
    pushHandlers,
  };
}

function source(initial: Connection | null): ConnectionSource & { set(c: Connection | null): void } {
  let current = initial;
  const listeners = new Set<(c: Connection | null) => void>();
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(c) {
      current = c;
      for (const l of listeners) l(c);
    },
  };
}

const message = (body: Record<string, unknown>) => JSON.stringify({ v: CHANNEL_VERSION, ...body });

function bench(initial: Connection | null) {
  const src = source(initial);
  const endpoint = workstationEndpoint(src, { invokeTimeoutMs: 100, listenTimeoutMs: 100 });
  const replies: Array<Record<string, unknown>> = [];
  const reply = (raw: string) => replies.push(JSON.parse(raw));
  const stop = endpoint.start?.();
  return { src, endpoint: endpoint.endpoint, replies, reply, stop: stop ?? (() => {}) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a paired Workstation's end of the channel", () => {
  it("invokes: a DesktopResult's value comes back as the result, its error as a failure", async () => {
    const s = scripted();
    s.answers.set("InvokeDesktop", (m) =>
      m.command === "get_board" ? { type: "DesktopResult", value: { columns: [] } } : { type: "DesktopResult", error: "no such workspace" }
    );
    const b = bench(s.connection);
    b.endpoint.receive(message({ type: "invoke", id: 1, cmd: "get_board", args: { workspaceId: "w" } }), b.reply);
    b.endpoint.receive(message({ type: "invoke", id: 2, cmd: "get_tree", args: {} }), b.reply);
    await flush();
    expect(s.sent).toEqual([
      { type: "InvokeDesktop", command: "get_board", args: { workspaceId: "w" } },
      { type: "InvokeDesktop", command: "get_tree", args: {} },
    ]);
    expect(b.replies).toEqual([
      { v: 1, type: "result", id: 1, ok: true, value: { columns: [] } },
      { v: 1, type: "result", id: 2, ok: false, error: "no such workspace" },
    ]);
  });

  it("says, in words, when the daemon refuses, when the desktop is not running, and when there is no connection", async () => {
    const s = scripted();
    s.answers.set("InvokeDesktop", (m) => {
      if (m.command === "save_layout") return { type: "Error", message: "gavin-daemon: remote role may not invoke `save_layout`" };
      if (m.command === "old") return { type: "Unsupported", request_type: "InvokeDesktop", min_version: 54 };
      return { type: "Error", message: "gavin-daemon: desktop app not running" };
    });
    const b = bench(s.connection);
    b.endpoint.receive(message({ type: "invoke", id: 1, cmd: "save_layout", args: {} }), b.reply);
    b.endpoint.receive(message({ type: "invoke", id: 2, cmd: "old", args: {} }), b.reply);
    b.endpoint.receive(message({ type: "invoke", id: 3, cmd: "get_board", args: {} }), b.reply);
    await flush();
    expect(b.replies.map((r) => r.error)).toEqual([
      "gavin-daemon: remote role may not invoke `save_layout`",
      "The Workstation's Gavin is too old for this. Update Gavin at the desk.",
      "gavin-daemon: desktop app not running",
    ]);

    b.src.set(null);
    b.endpoint.receive(message({ type: "invoke", id: 4, cmd: "get_board", args: {} }), b.reply);
    await flush();
    expect(b.replies[3]).toEqual({ v: 1, type: "result", id: 4, ok: false, error: NOT_CONNECTED });
    expect(s.sent).toHaveLength(3);

    expect(problemOf({ type: "Forbidden", role: "remote", request_type: "ListDevices" })).toMatch(/does not let a phone ListDevices/);
    expect(problemOf(null)).toMatch(/not one this Companion reads/);
    expect(problemOf({ type: "Mystery" })).toMatch(/Mystery/);
  });

  it("listens once per event name, delivers each push to every listener, and unlistens with the last", async () => {
    const s = scripted();
    s.answers.set("ListenDesktop", () => ({ type: "Ok" }));
    s.answers.set("UnlistenDesktop", () => ({ type: "Ok" }));
    const b = bench(s.connection);
    b.endpoint.receive(message({ type: "listen", id: 10, event: "session-status-changed" }), b.reply);
    b.endpoint.receive(message({ type: "listen", id: 11, event: "session-status-changed" }), b.reply);
    b.endpoint.receive(message({ type: "listen", id: 12, event: "gavin-tree-changed" }), b.reply);
    await flush();
    expect(s.sent).toEqual([
      { type: "ListenDesktop", event: "session-status-changed" },
      { type: "ListenDesktop", event: "gavin-tree-changed" },
    ]);
    expect(b.replies.map((r) => [r.id, r.ok])).toEqual([
      [11, true],
      [10, true],
      [12, true],
    ]);

    s.push({ type: "DesktopEvent", event: "session-status-changed", payload: ["s1", "idle"] });
    s.push({ type: "DesktopEvent", event: "nobody-listens", payload: 1 });
    s.push({ type: "DeviceConnected", device_id: "x" });
    expect(b.replies.slice(3)).toEqual([
      { v: 1, type: "event", listener: 10, event: "session-status-changed", payload: ["s1", "idle"] },
      { v: 1, type: "event", listener: 11, event: "session-status-changed", payload: ["s1", "idle"] },
    ]);

    // One listener of two goes: the wire keeps the listen. The last: it ends.
    b.endpoint.receive(message({ type: "unlisten", id: 20, listener: 10 }), b.reply);
    await flush();
    expect(s.sent).toHaveLength(2);
    b.endpoint.receive(message({ type: "unlisten", id: 21, listener: 11 }), b.reply);
    await flush();
    expect(s.sent[2]).toEqual({ type: "UnlistenDesktop", event: "session-status-changed" });
    expect(b.replies.slice(5).map((r) => [r.id, r.ok])).toEqual([
      [20, true],
      [21, true],
    ]);
    s.push({ type: "DesktopEvent", event: "session-status-changed", payload: ["s1", "working"] });
    expect(b.replies).toHaveLength(7);
    // An unlisten of a listener that never was is still answered.
    b.endpoint.receive(message({ type: "unlisten", id: 22, listener: 99 }), b.reply);
    expect(b.replies[7]).toEqual({ v: 1, type: "result", id: 22, ok: true, value: null });
  });

  it("listens again on a connection that comes back, and hears nothing from the old one", async () => {
    const first = scripted();
    first.answers.set("ListenDesktop", () => ({ type: "Ok" }));
    const b = bench(first.connection);
    b.endpoint.receive(message({ type: "listen", id: 1, event: "workspaces-synced" }), b.reply);
    await flush();
    expect(first.pushHandlers.size).toBe(1);

    // Dropped: no connection. A listen made now is registered here and
    // answered, and the wire hears of it when a connection comes.
    b.src.set(null);
    expect(first.pushHandlers.size).toBe(0);
    b.endpoint.receive(message({ type: "listen", id: 2, event: "session-status-changed" }), b.reply);
    await flush();
    expect(b.replies[1]).toEqual({ v: 1, type: "result", id: 2, ok: true, value: null });

    const second = scripted();
    second.answers.set("ListenDesktop", () => ({ type: "Ok" }));
    b.src.set(second.connection);
    await flush();
    expect(second.sent.map((m) => m.event).sort()).toEqual(["session-status-changed", "workspaces-synced"]);
    second.push({ type: "DesktopEvent", event: "workspaces-synced", payload: { n: 1 } });
    first.push({ type: "DesktopEvent", event: "workspaces-synced", payload: { n: 0 } });
    expect(b.replies.slice(2)).toEqual([{ v: 1, type: "event", listener: 1, event: "workspaces-synced", payload: { n: 1 } }]);

    // Stopping ends the listens on the connection that stays.
    second.answers.set("UnlistenDesktop", () => ({ type: "Ok" }));
    b.stop();
    await flush();
    expect(second.sent.filter((m) => m.type === "UnlistenDesktop").map((m) => m.event).sort()).toEqual([
      "session-status-changed",
      "workspaces-synced",
    ]);
    expect(second.pushHandlers.size).toBe(0);
    second.push({ type: "DesktopEvent", event: "workspaces-synced", payload: { n: 2 } });
    expect(b.replies).toHaveLength(3);
  });

  it("answers what is not the Workstation's, and what it cannot read, rather than dropping it", async () => {
    const s = scripted();
    const b = bench(s.connection);
    b.endpoint.receive(message({ type: "return-to-hub", id: 5 }), b.reply);
    b.endpoint.receive(message({ type: "invoke", id: 6, cmd: "", args: {} }), b.reply);
    b.endpoint.receive(message({ type: "teleport", id: 7 }), b.reply);
    b.endpoint.receive("not json", b.reply);
    expect(b.replies.map((r) => [r.id, r.ok])).toEqual([
      [5, false],
      [6, false],
      [7, false],
    ]);
    expect(s.sent).toEqual([]);
  });

  it("a request that fails on the connection is a failure the bundle hears", async () => {
    const s = scripted();
    s.answers.set("InvokeDesktop", () => {
      throw new Error("the Workstation did not answer in time");
    });
    const b = bench(s.connection);
    b.endpoint.receive(message({ type: "invoke", id: 1, cmd: "get_board", args: {} }), b.reply);
    await flush();
    expect(b.replies[0]).toEqual({ v: 1, type: "result", id: 1, ok: false, error: "the Workstation did not answer in time" });
    // A listen's failure too.
    s.answers.set("ListenDesktop", () => ({ type: "Error", message: "only a Device can listen" }));
    b.endpoint.receive(message({ type: "listen", id: 2, event: "e" }), b.reply);
    await flush();
    expect(b.replies[1]).toEqual({ v: 1, type: "result", id: 2, ok: false, error: "only a Device can listen" });
    expect(encode({ v: 1, type: "result", id: 2, ok: false, error: "x" })).toContain('"ok":false');
  });
});
