// A connection to a paired Workstation, against a scripted core, Relay and
// keys: each way it can end, named as the hub shows it, and a live
// connection's requests. The real core against a real daemon is
// `hub.e2e.ts`'s.
import { describe, expect, it, vi } from "vitest";
import { CoreError, type ConnectEvent, type CoreExchange, type CoreModule } from "$shell/core/core";
import { connect, refusalIsFinal, type ConnectDeps, type ConnectTarget } from "$shell/connection/connection";
import { RelayLegError, type RelayMessage, type RelaySocket } from "$shell/pairing/relaySocket";

const HASH = "ab".repeat(32);
const TARGET: ConnectTarget = { workstationKey: "42".repeat(32), relays: ["ws://127.0.0.1:8443"], relayAdmission: "let-me-in" };
const DIAL = { url: "ws://127.0.0.1:8443", hello: '{"role":"device","purpose":"connect"}' };

/// Frames on the stream are one byte naming what the scripted Workstation
/// said: 2 message two, 5 connected, 6 a refusal, 7 a line of the
/// protocol (`lines` says which), 8 connected with a line in the same
/// read, 9 bytes the core cannot open.
function scriptedCore(options: { dials?: Array<typeof DIAL>; refusal?: ConnectEvent } = {}) {
  const sent: string[] = [];
  const lines: string[] = [];
  const exchange: CoreExchange = {
    pairingStart: () => {
      throw new Error("a connection does not pair");
    },
    bundleOpen: () => {
      throw new Error("a connection opens no bundle");
    },
    pairingReceive: () => [],
    pairingProve: () => [],
    connectStart: () => ({ send: new Uint8Array([1]), dials: options.dials ?? [DIAL] }),
    connectReceive(bytes): ConnectEvent[] {
      switch (bytes[0]) {
        case 2:
          return [{ type: "prove", handshakeHash: HASH }];
        case 5:
          return [{ type: "connected", deviceId: "dev-1" }];
        case 6:
          return [options.refusal ?? { type: "refused", reason: "revoked", message: "this Device was revoked at the Workstation" }];
        case 7:
          return [{ type: "message", text: lines.shift() ?? "{}" }];
        case 8:
          return [
            { type: "connected", deviceId: "dev-1" },
            { type: "message", text: lines.shift() ?? "{}" },
          ];
        default:
          throw new CoreError("frame", "a frame did not open");
      }
    },
    connectProve: () => [{ type: "send", bytes: new Uint8Array([0x30]) }],
    connectSend: (message) => {
      sent.push(message);
      return new Uint8Array([0x40]);
    },
    relayReply(text) {
      const reply = JSON.parse(text);
      if (reply.type === "ready") return { reply: "ready" };
      return { reply: "refused", reason: reply.reason, message: `refused: ${reply.reason}` };
    },
  };
  const core: CoreModule = { exchange: async () => exchange };
  return { core, sent, lines };
}

const text = (t: string): RelayMessage => ({ kind: "text", text: t });
const byte = (b: number): RelayMessage => ({ kind: "bytes", bytes: new Uint8Array([b]) });
const READY = text('{"type":"ready"}');

/// A Relay leg that answers from `script`, then waits for `push` until
/// closed.
function leg(script: RelayMessage[]) {
  const sent: Array<string | number[]> = [];
  let waiter: { resolve(m: RelayMessage): void; reject(e: Error): void } | null = null;
  let closed = false;
  const socket: RelaySocket = {
    next: () => {
      const message = script.shift();
      if (message) return Promise.resolve(message);
      if (closed) return Promise.reject(new RelayLegError("closed", "closed"));
      return new Promise((resolve, reject) => (waiter = { resolve, reject }));
    },
    send: (data) => void sent.push(typeof data === "string" ? data : Array.from(data)),
    close: () => {
      closed = true;
      waiter?.reject(new RelayLegError("closed", "closed"));
      waiter = null;
    },
  };
  return {
    socket,
    sent,
    isClosed: () => closed,
    push(message: RelayMessage) {
      const w = waiter;
      waiter = null;
      if (w) w.resolve(message);
      else script.push(message);
    },
    /// The Workstation hangs up.
    hangUp() {
      closed = true;
      waiter?.reject(new RelayLegError("closed", "closed"));
      waiter = null;
    },
  };
}

function keys(sign?: () => Promise<{ signature: string }>) {
  return {
    noiseKey: vi.fn(async () => ({ privateKey: "11".repeat(32) })),
    signUnlocked: vi.fn(sign ?? (async () => ({ signature: "3045022100aa" }))),
  };
}

function deps(core: CoreModule, legs: Array<ReturnType<typeof leg> | Error>, k = keys()): ConnectDeps {
  const queue = [...legs];
  return {
    core,
    keys: k,
    open: vi.fn(async () => {
      const next = queue.shift();
      if (!next || next instanceof Error) throw next ?? new RelayLegError("unreachable", "no Relay");
      return next.socket;
    }),
    random: (n) => new Uint8Array(n).fill(7),
  };
}

const refusedBy = (reason: string) => text(JSON.stringify({ type: "refused", reason }));

describe("connecting to a paired Workstation", () => {
  it("dials, signs under the Unlock without asking, and is given the Remote role", async () => {
    const { core } = scriptedCore();
    const relay = leg([READY, byte(2), byte(5)]);
    const k = keys();
    const outcome = await connect(TARGET, deps(core, [relay], k));
    expect(outcome.outcome).toBe("connected");
    // The hello, the handshake's first message, the proof.
    expect(relay.sent).toEqual([DIAL.hello, [1], [0x30]]);
    expect(k.signUnlocked).toHaveBeenCalledWith({ handshakeHash: HASH });
    expect(relay.isClosed()).toBe(false);
    if (outcome.outcome === "connected") {
      expect(outcome.deviceId).toBe("dev-1");
      outcome.connection.close();
    }
    expect(relay.isClosed()).toBe(true);
  });

  it("is asleep when a Relay holds no Workstation under its key", async () => {
    const { core } = scriptedCore();
    const relay = leg([refusedBy("offline")]);
    expect(await connect(TARGET, deps(core, [relay]))).toEqual({ outcome: "asleep" });
    expect(relay.isClosed()).toBe(true);
  });

  it("tries each Relay in turn, and is asleep if one answered and none had it", async () => {
    const { core } = scriptedCore({ dials: [DIAL, { ...DIAL, url: "wss://relay.example" }] });
    const outcome = await connect(TARGET, deps(core, [new RelayLegError("unreachable", "no"), leg([refusedBy("offline")])]));
    expect(outcome).toEqual({ outcome: "asleep" });
  });

  it("is unreachable when no Relay answers, and says which", async () => {
    const { core } = scriptedCore();
    const outcome = await connect(TARGET, deps(core, [new RelayLegError("unreachable", "no")]));
    expect(outcome).toEqual({
      outcome: "unreachable",
      problem: "Could not reach its Relay at ws://127.0.0.1:8443. Check that this phone is online.",
    });
  });

  it("is unreachable, in the Relay's words, when a Relay turns it away for another reason", async () => {
    const { core } = scriptedCore();
    const outcome = await connect(TARGET, deps(core, [leg([refusedBy("admission")])]));
    expect(outcome).toEqual({ outcome: "unreachable", problem: "Its Relay turned the connection away: refused: admission." });
  });

  it("is unreachable when the Workstation hangs up during the handshake", async () => {
    const { core } = scriptedCore();
    const relay = leg([READY]);
    const running = connect(TARGET, deps(core, [relay]));
    await vi.waitFor(() => expect(relay.sent).toHaveLength(2));
    relay.hangUp();
    expect(await running).toEqual({ outcome: "unreachable", problem: "It ended the connection before it was made." });
  });

  it("says why the Workstation refused, and whether trying again can help", async () => {
    const { core } = scriptedCore();
    const outcome = await connect(TARGET, deps(core, [leg([READY, byte(2), byte(6)])]));
    expect(outcome).toEqual({ outcome: "refused", reason: "revoked", problem: "This Device was revoked at the Workstation." });
    expect(refusalIsFinal("revoked")).toBe(true);
    expect(refusalIsFinal("not-paired")).toBe(true);
    expect(refusalIsFinal("busy")).toBe(false);
    expect(refusalIsFinal("unlock")).toBe(false);
  });

  it("is locked when no Unlock is held, and lapsed when the Unlock no longer covers it; nothing prompts", async () => {
    const locked = keys(async () => {
      throw Object.assign(new Error("no Unlock is held"), { code: "locked" });
    });
    const { core } = scriptedCore();
    const relay = leg([READY, byte(2)]);
    expect(await connect(TARGET, deps(core, [relay], locked))).toEqual({ outcome: "locked" });
    expect(relay.isClosed()).toBe(true);

    const lapsed = keys(async () => {
      throw Object.assign(new Error("user not authenticated"), { code: "unlock-expired" });
    });
    expect(await connect(TARGET, deps(scriptedCore().core, [leg([READY, byte(2)])], lapsed))).toEqual({
      outcome: "lapsed",
    });
  });

  it("fails, in words, when this phone has lost its keys", async () => {
    const gone = keys(async () => {
      throw Object.assign(new Error("no keys"), { code: "no-keys" });
    });
    expect(await connect(TARGET, deps(scriptedCore().core, [leg([READY, byte(2)])], gone))).toEqual({
      outcome: "failed",
      problem: "This phone no longer holds its Device keys. Pair it again.",
    });
  });

  it("fails before dialling when the Workstation names no Relay this phone may dial", async () => {
    const { core } = scriptedCore({ dials: [] });
    const d = deps(core, []);
    expect((await connect(TARGET, d)).outcome).toBe("failed");
    expect(d.open).not.toHaveBeenCalled();
  });

  it("gives up when stopped, and closes what it opened", async () => {
    const { core } = scriptedCore();
    const relay = leg([READY]);
    const abort = new AbortController();
    const d = { ...deps(core, [relay]), signal: abort.signal };
    const running = connect(TARGET, d);
    await vi.waitFor(() => expect(relay.sent).toHaveLength(2));
    abort.abort();
    expect((await running).outcome).toBe("unreachable");
    expect(relay.isClosed()).toBe(true);
  });
});

describe("a live connection", () => {
  async function connected() {
    const script = scriptedCore();
    const relay = leg([READY, byte(2), byte(5)]);
    const outcome = await connect(TARGET, deps(script.core, [relay]));
    if (outcome.outcome !== "connected") throw new Error(JSON.stringify(outcome));
    return { ...script, relay, connection: outcome.connection };
  }

  it("sends a request and resolves with the first message that answers it", async () => {
    const { connection, relay, sent, lines } = await connected();
    const answered = connection.request({ type: "GetAttention", version: 1 }, (r) => (r as { type: string }).type === "Attention", 1000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.parse(sent[0])).toEqual({ type: "GetAttention", version: 1 });
    lines.push('{"type":"DesktopEvent"}', '{"type":"Attention","state":"ready","items":[]}');
    relay.push(byte(7));
    relay.push(byte(7));
    expect(await answered).toEqual({ type: "Attention", state: "ready", items: [] });
  });

  it("keeps what arrived with the verdict for the first request", async () => {
    const script = scriptedCore();
    script.lines.push('{"type":"Attention","state":"desktop-app-not-running","items":[]}');
    const relay = leg([READY, byte(2), byte(8)]);
    const outcome = await connect(TARGET, deps(script.core, [relay]));
    if (outcome.outcome !== "connected") throw new Error(JSON.stringify(outcome));
    expect(await outcome.connection.request({}, () => true, 1000)).toEqual({
      type: "Attention",
      state: "desktop-app-not-running",
      items: [],
    });
  });

  it("answers requests one at a time", async () => {
    const { connection, relay, sent, lines } = await connected();
    const first = connection.request({ n: 1 }, () => true, 1000);
    const second = connection.request({ n: 2 }, () => true, 1000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    lines.push('{"answer":1}');
    relay.push(byte(7));
    expect(await first).toEqual({ answer: 1 });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    lines.push('{"answer":2}');
    relay.push(byte(7));
    expect(await second).toEqual({ answer: 2 });
  });

  it("times a request out, and leaves the connection open", async () => {
    const { connection } = await connected();
    await expect(connection.request({}, () => true, 5)).rejects.toThrow("did not answer in time");
    expect(connection.isClosed).toBe(false);
  });

  it("settles `closed` when the Workstation hangs up, and fails the request waiting", async () => {
    const { connection, relay } = await connected();
    const waiting = connection.request({}, () => true, 10_000);
    relay.hangUp();
    await expect(waiting).rejects.toThrow("The Workstation ended the connection.");
    expect(await connection.closed).toBe("The Workstation ended the connection.");
    expect(connection.isClosed).toBe(true);
    await expect(connection.request({}, () => true, 10)).rejects.toThrow("closed");
  });

  it("hands a push to whoever listens, and the answer to the request waiting", async () => {
    const { connection, relay, sent, lines } = await connected();
    const pushed: unknown[] = [];
    const stop = connection.onPush((m) => pushed.push(m));
    // With nothing asked, a push goes to the listener and is not kept.
    lines.push('{"type":"DesktopEvent","event":"e","payload":1}');
    relay.push(byte(7));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    // While a request waits, a push still goes to the listener and the
    // answer to the request.
    const answered = connection.request({ type: "GetAttention", version: 1 }, (r) => (r as { type: string }).type === "Attention", 1000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    lines.push('{"type":"DesktopEvent","event":"e","payload":2}', '{"type":"Attention","state":"ready","items":[]}');
    relay.push(byte(7));
    relay.push(byte(7));
    expect(await answered).toEqual({ type: "Attention", state: "ready", items: [] });
    await vi.waitFor(() => expect(pushed).toHaveLength(2));
    expect(pushed[1]).toEqual({ type: "DesktopEvent", event: "e", payload: 2 });
    // Stopped: a later push is kept for the next request to pass over.
    stop();
    lines.push('{"type":"DesktopEvent","event":"e","payload":3}');
    relay.push(byte(7));
    await new Promise((r) => setTimeout(r, 5));
    expect(pushed).toHaveLength(2);
    const later = connection.request({}, (r) => (r as { answer?: number }).answer === 4, 1000);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    lines.push('{"answer":4}');
    relay.push(byte(7));
    expect(await later).toEqual({ answer: 4 });
  });

  it("ends on a frame that does not open: the channel's count is wrong for good", async () => {
    const { connection, relay } = await connected();
    relay.push(byte(0x99));
    expect(await connection.closed).toContain("a frame did not open");
    expect(relay.isClosed()).toBe(true);
  });
});
