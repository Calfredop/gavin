// The live hub against scripted connections and a fake clock: one Unlock
// connects every Workstation, a drop reconnects without the Unlock being
// asked again, the Unlock ending drops everything, and each Workstation's
// state is what its connection said.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionAnswer, AttentionItem } from "$shell/connection/attention";
import type { Connection, ConnectOutcome, ConnectTarget } from "$shell/connection/connection";
import { combinedInbox } from "$shell/hub/inbox";
import type { LiveState } from "$shell/hub/live";
import { createLiveHub, type LiveHubDeps } from "$shell/hub/liveHub";
import type { PairedWorkstation } from "$shell/hub/paired";

function record(n: number, name: string): PairedWorkstation {
  const key = `${n}${n}`.repeat(32);
  return {
    id: `ws-${key.slice(0, 16)}`,
    name,
    pairedAt: n,
    workstationKey: key,
    relays: ["ws://127.0.0.1:8443"],
    relayAdmission: null,
    deviceId: `dev-${n}`,
    notificationKey: "5a".repeat(32),
  };
}

const STUDIO = record(1, "Studio");
const LAPTOP = record(2, "Laptop");

const item = (id: string): AttentionItem => ({
  id,
  workspace: "w",
  kind: "waiting",
  text: `${id} asks`,
  target: { kind: "session", id },
});

/// A connection the test can drop.
function fakeConnection() {
  let settle!: (why: string) => void;
  let isClosed = false;
  const closed = new Promise<string>((resolve) => (settle = resolve));
  const connection: Connection = {
    request: vi.fn(),
    close: vi.fn((why = "closed") => {
      if (isClosed) return;
      isClosed = true;
      settle(why);
    }),
    closed,
    get isClosed() {
      return isClosed;
    },
  };
  return { connection, drop: (why: string) => connection.close(why) };
}

/// Scripted Workstations: what connecting answers, by Workstation key, and
/// what asking answers, by connection.
function bench() {
  const outcomes = new Map<string, Array<() => ConnectOutcome>>();
  const answers = new Map<Connection, () => Promise<AttentionAnswer>>();
  const connections: Array<ReturnType<typeof fakeConnection> & { key: string }> = [];
  const live: Array<Record<string, LiveState>> = [];
  const connect = vi.fn(async (target: ConnectTarget): Promise<ConnectOutcome> => {
    const next = outcomes.get(target.workstationKey)?.shift();
    return next ? next() : { outcome: "unreachable", problem: "No script." };
  });
  const deps: LiveHubDeps = {
    connect,
    ask: vi.fn(async (connection) => (answers.get(connection) ?? (async () => ({ state: "ready", items: [] })))()),
    now: () => Date.now(),
    after: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    onChange: (snapshot) => live.push(snapshot),
    onNotHeld: vi.fn(),
    onLapsed: vi.fn(),
  };
  return {
    deps,
    connect,
    connections,
    latest: () => live[live.length - 1] ?? {},
    /// The next connection to `ws` succeeds, and its asks answer `answer`.
    willConnect(ws: PairedWorkstation, answer: () => Promise<AttentionAnswer> = async () => ({ state: "ready", items: [] })) {
      const list = outcomes.get(ws.workstationKey) ?? [];
      list.push(() => {
        const made = { ...fakeConnection(), key: ws.workstationKey };
        connections.push(made);
        answers.set(made.connection, answer);
        return { outcome: "connected", connection: made.connection, deviceId: ws.deviceId };
      });
      outcomes.set(ws.workstationKey, list);
    },
    willFail(ws: PairedWorkstation, outcome: ConnectOutcome) {
      const list = outcomes.get(ws.workstationKey) ?? [];
      list.push(() => outcome);
      outcomes.set(ws.workstationKey, list);
    },
    connectionsTo(ws: PairedWorkstation) {
      return connections.filter((c) => c.key === ws.workstationKey);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/// Lets every pending promise run.
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("the live hub", () => {
  it("stays locked, connecting nothing, until the Unlock allows it", async () => {
    const b = bench();
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO, LAPTOP]);
    await settle();
    expect(b.connect).not.toHaveBeenCalled();
    expect(b.latest()).toEqual({ [STUDIO.id]: { state: "locked" }, [LAPTOP.id]: { state: "locked" } });
  });

  it("connects every Workstation on one Unlock, and gathers what each has waiting", async () => {
    const b = bench();
    b.willConnect(STUDIO, async () => ({ state: "ready", items: [item("s1")] }));
    b.willConnect(LAPTOP, async () => ({ state: "ready", items: [item("l1"), item("l2")] }));
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO, LAPTOP]);
    hub.setAllowed(true);
    await settle();

    expect(b.connect).toHaveBeenCalledTimes(2);
    expect(b.latest()[STUDIO.id]).toEqual({ state: "ready", items: [item("s1")] });
    expect(b.latest()[LAPTOP.id]).toEqual({ state: "ready", items: [item("l1"), item("l2")] });
    expect(combinedInbox([STUDIO, LAPTOP], b.latest()).map((r) => `${r.workstationName}: ${r.text}`)).toEqual([
      "Studio: s1 asks",
      "Laptop: l1 asks",
      "Laptop: l2 asks",
    ]);
  });

  it("shows a Workstation whose desktop app is not running, one that is asleep and one that is unreachable, and none adds to the inbox", async () => {
    const b = bench();
    const OFFICE = record(3, "Office");
    b.willConnect(STUDIO, async () => ({ state: "desktop-app-not-running" }));
    b.willFail(LAPTOP, { outcome: "asleep" });
    b.willFail(OFFICE, { outcome: "unreachable", problem: "Could not reach its Relay." });
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO, LAPTOP, OFFICE]);
    hub.setAllowed(true);
    await settle();

    expect(b.latest()).toEqual({
      [STUDIO.id]: { state: "desktop-app-not-running" },
      [LAPTOP.id]: { state: "asleep" },
      [OFFICE.id]: { state: "unreachable", problem: "Could not reach its Relay." },
    });
    expect(combinedInbox([STUDIO, LAPTOP, OFFICE], b.latest())).toEqual([]);
  });

  it("asks again every poll, so an item dealt with at the desk leaves the phone", async () => {
    const b = bench();
    let items = [item("s1")];
    b.willConnect(STUDIO, async () => ({ state: "ready", items }));
    const hub = createLiveHub({ ...b.deps, pollMs: 1000 });
    hub.setPaired([STUDIO]);
    hub.setAllowed(true);
    await settle();
    expect(combinedInbox([STUDIO], b.latest())).toHaveLength(1);

    items = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.latest()[STUDIO.id]).toEqual({ state: "ready", items: [] });
    expect(b.connect).toHaveBeenCalledTimes(1);
  });

  it("reconnects a dropped connection, backing off, without the Unlock being asked", async () => {
    const b = bench();
    b.willConnect(STUDIO);
    b.willFail(STUDIO, { outcome: "unreachable", problem: "Could not reach its Relay." });
    b.willConnect(STUDIO, async () => ({ state: "ready", items: [item("back")] }));
    const hub = createLiveHub({ ...b.deps, reconnect: { floorMs: 100, ceilingMs: 1000, settledMs: 10_000 } });
    hub.setPaired([STUDIO]);
    hub.setAllowed(true);
    await settle();
    expect(b.latest()[STUDIO.id]).toEqual({ state: "ready", items: [] });

    // The network drops.
    b.connectionsTo(STUDIO)[0].drop("The Workstation ended the connection.");
    await settle();
    expect(b.latest()[STUDIO.id]).toEqual({ state: "unreachable", problem: "The Workstation ended the connection." });

    await vi.advanceTimersByTimeAsync(100); // the first try: still no Relay
    expect(b.connect).toHaveBeenCalledTimes(2);
    expect(b.latest()[STUDIO.id]).toEqual({ state: "unreachable", problem: "Could not reach its Relay." });
    await vi.advanceTimersByTimeAsync(199);
    expect(b.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // the second, twice as late
    expect(b.connect).toHaveBeenCalledTimes(3);
    expect(b.latest()[STUDIO.id]).toEqual({ state: "ready", items: [item("back")] });

    expect(b.deps.onNotHeld).not.toHaveBeenCalled();
    expect(b.deps.onLapsed).not.toHaveBeenCalled();
  });

  it("takes a connection whose ask fails for dead, and reconnects", async () => {
    const b = bench();
    b.willConnect(STUDIO, async () => {
      throw new Error("the Workstation did not answer in time");
    });
    b.willConnect(STUDIO);
    const hub = createLiveHub({ ...b.deps, reconnect: { floorMs: 50, ceilingMs: 50, settledMs: 10_000 } });
    hub.setPaired([STUDIO]);
    hub.setAllowed(true);
    await settle();
    expect(b.latest()[STUDIO.id]).toEqual({ state: "unreachable", problem: "The Workstation did not answer in time." });
    expect(b.connectionsTo(STUDIO)[0].connection.isClosed).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(b.latest()[STUDIO.id]).toEqual({ state: "ready", items: [] });
  });

  it("drops every connection and stops every retry when the Unlock ends", async () => {
    const b = bench();
    b.willConnect(STUDIO);
    b.willFail(LAPTOP, { outcome: "asleep" });
    const hub = createLiveHub({ ...b.deps, reconnect: { floorMs: 100, ceilingMs: 100, settledMs: 10_000 } });
    hub.setPaired([STUDIO, LAPTOP]);
    hub.setAllowed(true);
    await settle();

    hub.setAllowed(false);
    await settle();
    expect(b.connectionsTo(STUDIO)[0].connection.isClosed).toBe(true);
    expect(b.latest()).toEqual({ [STUDIO.id]: { state: "locked" }, [LAPTOP.id]: { state: "locked" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.connect).toHaveBeenCalledTimes(2);
  });

  it("does not keep a connection that completes after the Unlock ended", async () => {
    const b = bench();
    let finish!: (o: ConnectOutcome) => void;
    b.connect.mockImplementationOnce(() => new Promise<ConnectOutcome>((resolve) => (finish = resolve)));
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO]);
    hub.setAllowed(true);
    await settle();
    hub.setAllowed(false);
    const late = fakeConnection();
    finish({ outcome: "connected", connection: late.connection, deviceId: "dev-1" });
    await settle();
    expect(late.connection.isClosed).toBe(true);
    expect(b.latest()[STUDIO.id]).toEqual({ state: "locked" });
  });

  it("does not try again a Workstation that refused this Device for good, until the next Unlock", async () => {
    const b = bench();
    b.willFail(STUDIO, { outcome: "refused", reason: "revoked", problem: "This Device was revoked at the Workstation." });
    b.willConnect(STUDIO);
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO]);
    hub.setAllowed(true);
    await settle();
    expect(b.latest()[STUDIO.id]).toEqual({ state: "refused", problem: "This Device was revoked at the Workstation." });
    await vi.advanceTimersByTimeAsync(120_000);
    hub.refresh();
    await settle();
    expect(b.connect).toHaveBeenCalledTimes(1);

    hub.setAllowed(false);
    hub.setAllowed(true);
    await settle();
    expect(b.connect).toHaveBeenCalledTimes(2);
  });

  it("tries again a Workstation that turned it away for now", async () => {
    const b = bench();
    b.willFail(STUDIO, { outcome: "refused", reason: "busy", problem: "This Device already holds as many connections as it may." });
    b.willConnect(STUDIO);
    const hub = createLiveHub({ ...b.deps, reconnect: { floorMs: 10, ceilingMs: 10, settledMs: 10_000 } });
    hub.setPaired([STUDIO]);
    hub.setAllowed(true);
    await settle();
    expect(b.latest()[STUDIO.id].state).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(10);
    expect(b.latest()[STUDIO.id]).toEqual({ state: "ready", items: [] });
  });

  it("hands the Unlock's news on: no Unlock held, or one that lapsed", async () => {
    const b = bench();
    b.willFail(STUDIO, { outcome: "locked" });
    b.willFail(LAPTOP, { outcome: "lapsed" });
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO, LAPTOP]);
    hub.setAllowed(true);
    await settle();
    expect(b.deps.onNotHeld).toHaveBeenCalledTimes(1);
    expect(b.deps.onLapsed).toHaveBeenCalledTimes(1);
    expect(b.latest()).toEqual({ [STUDIO.id]: { state: "locked" }, [LAPTOP.id]: { state: "locked" } });
  });

  it("after a lapsed Unlock is renewed, connects the Workstations left out and keeps the ones open", async () => {
    const b = bench();
    b.willConnect(STUDIO);
    b.willFail(LAPTOP, { outcome: "lapsed" });
    b.willConnect(LAPTOP);
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO, LAPTOP]);
    hub.setAllowed(true);
    await settle();
    expect(b.latest()[LAPTOP.id]).toEqual({ state: "locked" });

    // The Unlock asked again (renewing) and the owner confirmed: still
    // allowed, so the hub is told to connect what is not connected.
    hub.setAllowed(true);
    await settle();
    expect(b.latest()[LAPTOP.id]).toEqual({ state: "ready", items: [] });
    expect(b.connectionsTo(STUDIO)).toHaveLength(1);
    expect(b.connectionsTo(STUDIO)[0].connection.isClosed).toBe(false);
  });

  it("connects a Workstation paired while unlocked, and drops one that is gone", async () => {
    const b = bench();
    b.willConnect(STUDIO);
    b.willConnect(LAPTOP);
    const hub = createLiveHub(b.deps);
    hub.setPaired([STUDIO]);
    hub.setAllowed(true);
    await settle();
    hub.setPaired([STUDIO, LAPTOP]);
    await settle();
    expect(b.latest()[LAPTOP.id]).toEqual({ state: "ready", items: [] });

    hub.setPaired([{ ...LAPTOP, name: "Renamed" }]);
    await settle();
    expect(b.connectionsTo(STUDIO)[0].connection.isClosed).toBe(true);
    expect(Object.keys(b.latest())).toEqual([LAPTOP.id]);
    expect(b.connectionsTo(LAPTOP)).toHaveLength(1);
  });

  it("on refresh asks every connected Workstation now, and tries every waiting one now", async () => {
    const b = bench();
    b.willConnect(STUDIO);
    b.willFail(LAPTOP, { outcome: "asleep" });
    b.willConnect(LAPTOP);
    const hub = createLiveHub({ ...b.deps, pollMs: 60_000, reconnect: { floorMs: 60_000, ceilingMs: 60_000, settledMs: 1 } });
    hub.setPaired([STUDIO, LAPTOP]);
    hub.setAllowed(true);
    await settle();
    expect(b.deps.ask).toHaveBeenCalledTimes(1);

    hub.refresh();
    await settle();
    expect(b.deps.ask).toHaveBeenCalledTimes(3);
    expect(b.latest()[LAPTOP.id]).toEqual({ state: "ready", items: [] });
  });
});
