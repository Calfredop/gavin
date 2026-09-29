// The pairing driver, against a scripted core, Relay and keys. What each
// test asserts is what the human would see (the phases, the words of a
// failure) and what the wire would carry (the frames sent, in order). The
// real core against a real daemon is `scripts/pair.sh`'s.
import { describe, expect, it, vi } from "vitest";
import { CoreError, type CoreExchange, type CoreModule, type KeptWorkstation, type PairingEvent } from "$shell/core/core";
import { refusalText } from "$shell/keys/deviceKeys";
import type { DeviceKeysStatus } from "$shell/native/deviceKeys";
import {
  deviceNameFrom,
  pair,
  PAIRING_SIGN_REASON,
  type PairingDeps,
  type PairingKeys,
  type PairingPhase,
} from "$shell/pairing/pairing";
import { RelayLegError, type RelayMessage, type RelaySocket } from "$shell/pairing/relaySocket";

const HASH = "ab".repeat(32);
const KEPT: KeptWorkstation = {
  workstationKey: "42".repeat(32),
  relays: ["ws://127.0.0.1:8443"],
  relayAdmission: "let-me-in",
  deviceId: "dev-1",
  notificationKey: "5a".repeat(32),
};

/// Frames on the stream are one byte, naming what the scripted
/// Workstation said: 2 message two, 4 the acknowledgement, 5-7 a verdict,
/// 9 a Workstation that is not the one scanned.
function scriptedCore(dials = [{ url: "ws://127.0.0.1:8443", hello: '{"role":"device"}' }]): CoreModule & {
  started: Array<Record<string, unknown>>;
} {
  const started: Array<Record<string, unknown>> = [];
  const exchange: CoreExchange = {
    pairingStart(options) {
      started.push({ ...options });
      return { send: new Uint8Array([1]), dials, workstationKey: KEPT.workstationKey };
    },
    pairingReceive(bytes): PairingEvent[] {
      switch (bytes[0]) {
        case 2:
          return [
            { type: "send", bytes: new Uint8Array([3]) },
            { type: "prove", handshakeHash: HASH },
          ];
        case 4:
          return [{ type: "compare-code", code: "123456" }];
        case 5:
          return [{ type: "finished", verdict: "paired", workstation: KEPT }];
        case 6:
          return [{ type: "finished", verdict: "rejected" }];
        case 7:
          return [{ type: "finished", verdict: "expired" }];
        default:
          throw new CoreError(
            "wrong-workstation",
            "this is not the Workstation whose code was scanned — the pairing was abandoned"
          );
      }
    },
    pairingProve: (signature) => [{ type: "send", bytes: new Uint8Array([0x30, signature.length]) }],
    connectStart: () => {
      throw new Error("a pairing does not connect");
    },
    connectReceive: () => [],
    connectProve: () => [],
    connectSend: () => new Uint8Array(),
    relayReply(text) {
      const reply = JSON.parse(text);
      if (reply.type === "ready") return { reply: "ready" };
      return { reply: "refused", reason: reply.reason, message: `refused for being ${reply.reason}` };
    },
  };
  return { started, exchange: async () => exchange };
}

const text = (t: string): RelayMessage => ({ kind: "text", text: t });
const byte = (b: number): RelayMessage => ({ kind: "bytes", bytes: new Uint8Array([b]) });
const READY = text('{"type":"ready"}');

/// A Relay leg that answers from `script` in order, then closes (or, with
/// `hold`, waits until closed).
function relay(script: RelayMessage[], hold = false) {
  const sent: Array<string | number[]> = [];
  const waiters: Array<(e: Error) => void> = [];
  let closed = false;
  const socket: RelaySocket = {
    next: () => {
      const message = script.shift();
      if (message) return Promise.resolve(message);
      if (!hold || closed) return Promise.reject(new RelayLegError("closed", "closed"));
      return new Promise((_, reject) => waiters.push(reject));
    },
    send: (data) => void sent.push(typeof data === "string" ? data : Array.from(data)),
    close: () => {
      closed = true;
      for (const reject of waiters.splice(0)) reject(new RelayLegError("closed", "closed"));
    },
  };
  return { socket, sent, isClosed: () => closed };
}

function keys(overrides: Partial<DeviceKeysStatus> = {}, sign?: () => Promise<{ signature: string }>) {
  const status: DeviceKeysStatus = {
    platform: "ios",
    passcodeSet: true,
    hardwareKeystore: true,
    softwareFallback: false,
    keys: null,
    debugBuild: false,
    checkRequested: false,
    ...overrides,
  };
  const made = { hardwareKey: `04${"66".repeat(64)}`, backing: "secure-enclave" as const, attestation: [] };
  return {
    status: vi.fn(async () => status),
    createKeys: vi.fn(async () => made),
    publicKeys: vi.fn(async () => made),
    noiseKey: vi.fn(async () => ({ privateKey: "11".repeat(32) })),
    sign: vi.fn(sign ?? (async () => ({ signature: "3045022100aa" }))),
  } satisfies PairingKeys;
}

function deps(options: {
  core?: ReturnType<typeof scriptedCore>;
  sockets?: Array<RelaySocket | Error>;
  keys?: ReturnType<typeof keys>;
  signal?: AbortSignal;
}) {
  const phases: PairingPhase[] = [];
  const sockets = [...(options.sockets ?? [])];
  const opened: string[] = [];
  const d: PairingDeps = {
    core: options.core ?? scriptedCore(),
    keys: options.keys ?? keys(),
    open: async (url) => {
      opened.push(url);
      const next = sockets.shift();
      if (!next || next instanceof Error) throw next ?? new RelayLegError("unreachable", "no route");
      return next;
    },
    random: (n) => new Uint8Array(n).fill(9),
    deviceName: "iPhone",
    onPhase: (phase) => void phases.push(phase),
    signal: options.signal,
  };
  return { d, phases, opened };
}

describe("pairing a phone with a Workstation", () => {
  it("runs the ceremony and keeps what the desk confirmed", async () => {
    const leg = relay([READY, byte(2), byte(4), byte(5)]);
    const k = keys();
    const core = scriptedCore();
    const { d, phases } = deps({ core, sockets: [leg.socket], keys: k });

    expect(await pair("the-qr", d)).toEqual({ outcome: "paired", workstation: KEPT });

    expect(phases).toEqual([
      { phase: "preparing" },
      { phase: "connecting" },
      { phase: "confirming" },
      { phase: "connecting" },
      { phase: "comparing", code: "123456" },
    ]);
    // The hello, the first message held until `ready`, message 3, the proof.
    expect(leg.sent).toEqual(['{"role":"device"}', [1], [3], [0x30, 12]]);
    expect(leg.isClosed()).toBe(true);
    // The first pairing makes the keys; the hardware key signs the bare hash.
    expect(k.createKeys).toHaveBeenCalledTimes(1);
    expect(k.publicKeys).not.toHaveBeenCalled();
    expect(k.sign).toHaveBeenCalledWith({ handshakeHash: HASH, reason: PAIRING_SIGN_REASON });
    expect(core.started).toEqual([
      {
        qr: "the-qr",
        noisePrivateKey: "11".repeat(32),
        hardwareKey: `04${"66".repeat(64)}`,
        deviceName: "iPhone",
        entropy: expect.any(Uint8Array),
      },
    ]);
    // Drawn fresh, and wiped once the core has it.
    const entropy = core.started[0].entropy as Uint8Array;
    expect(entropy.length).toBe(32);
    expect(Array.from(entropy)).toEqual(new Array(32).fill(0));
  });

  it("uses the keys this phone already holds for every Workstation after the first", async () => {
    const k = keys({ keys: { backing: "secure-enclave" } });
    const { d } = deps({ sockets: [relay([READY, byte(2), byte(4), byte(5)]).socket], keys: k });
    expect((await pair("qr", d)).outcome).toBe("paired");
    expect(k.createKeys).not.toHaveBeenCalled();
    expect(k.publicKeys).toHaveBeenCalledTimes(1);
  });

  it("refuses a phone that cannot be a Device before dialling anything", async () => {
    const { d, opened } = deps({ keys: keys({ passcodeSet: false }) });
    expect(await pair("qr", d)).toEqual({ outcome: "failed", problem: refusalText("no-passcode") });
    expect(opened).toEqual([]);

    const refusing = keys();
    refusing.createKeys.mockRejectedValue(Object.assign(new Error("software"), { code: "no-hardware-keystore" }));
    expect(await pair("qr", deps({ keys: refusing }).d)).toEqual({
      outcome: "failed",
      problem: refusalText("no-hardware-keystore"),
    });
  });

  it("says so when the code names no Relay the phone can reach", async () => {
    const { d, opened } = deps({ core: scriptedCore([]) });
    const outcome = await pair("qr", d);
    expect(outcome).toMatchObject({ outcome: "failed", problem: expect.stringContaining("names no Relay") });
    expect(opened).toEqual([]);
  });

  it("tries the next Relay when one cannot be reached, and tells the last reason when none can", async () => {
    const core = scriptedCore([
      { url: "wss://down.example", hello: "h1" },
      { url: "ws://127.0.0.1:8443", hello: "h2" },
    ]);
    const leg = relay([READY, byte(2), byte(4), byte(5)]);
    const { d, opened } = deps({ core, sockets: [new RelayLegError("unreachable", "no route"), leg.socket] });
    expect((await pair("qr", d)).outcome).toBe("paired");
    expect(opened).toEqual(["wss://down.example", "ws://127.0.0.1:8443"]);
    expect(leg.sent[0]).toBe("h2");

    const refused = relay([text('{"type":"refused","reason":"offline"}')]);
    const outcome = await pair("qr", deps({ core: scriptedCore(), sockets: [refused.socket] }).d);
    expect(outcome).toEqual({
      outcome: "failed",
      problem: "The Relay turned the pairing away: refused for being offline. Is remote access still on at the desk?",
    });
    expect(refused.isClosed()).toBe(true);
  });

  it("pairs nothing when the owner does not confirm on the phone", async () => {
    const k = keys({}, () => Promise.reject(Object.assign(new Error("no"), { code: "cancelled" })));
    const leg = relay([READY, byte(2)]);
    const outcome = await pair("qr", deps({ sockets: [leg.socket], keys: k }).d);
    expect(outcome).toEqual({ outcome: "failed", problem: "You did not confirm on this phone, so nothing was paired." });
    expect(leg.sent).toEqual(['{"role":"device"}', [1], [3]]);
    expect(leg.isClosed()).toBe(true);
  });

  it("says what the desk ruled when it did not pair", async () => {
    const rejected = await pair("qr", deps({ sockets: [relay([READY, byte(2), byte(4), byte(6)]).socket] }).d);
    expect(rejected).toEqual({ outcome: "failed", problem: "The desk declined this pairing. Nothing was paired." });
    const expired = await pair("qr", deps({ sockets: [relay([READY, byte(2), byte(4), byte(7)]).socket] }).d);
    expect(expired).toMatchObject({ outcome: "failed", problem: expect.stringContaining("Nobody confirmed at the desk") });
  });

  it("tells a stream that ended before the code from one that ended while the desk was asked", async () => {
    const early = await pair("qr", deps({ sockets: [relay([READY]).socket] }).d);
    expect(early).toMatchObject({ outcome: "failed", problem: expect.stringContaining("before the codes could be compared") });
    const late = await pair("qr", deps({ sockets: [relay([READY, byte(2), byte(4)]).socket] }).d);
    expect(late).toMatchObject({ outcome: "failed", problem: expect.stringContaining("stopped waiting for the desk") });
  });

  it("says the core's refusal in the core's own words", async () => {
    const outcome = await pair("qr", deps({ sockets: [relay([READY, byte(9)]).socket] }).d);
    expect(outcome).toEqual({
      outcome: "failed",
      problem: "This is not the Workstation whose code was scanned — the pairing was abandoned.",
    });
  });

  it("stops at once when cancelled while the desk is being asked", async () => {
    const leg = relay([READY, byte(2), byte(4)], true);
    const controller = new AbortController();
    const { d, phases } = deps({ sockets: [leg.socket], signal: controller.signal });
    const outcome = pair("qr", d);
    await vi.waitFor(() => expect(phases.at(-1)).toEqual({ phase: "comparing", code: "123456" }));
    controller.abort();
    expect(await outcome).toEqual({ outcome: "cancelled" });
    expect(leg.isClosed()).toBe(true);
  });

  it("stops at once when cancelled while the Relay has not answered", async () => {
    const leg = relay([], true);
    const controller = new AbortController();
    const { d, phases } = deps({ sockets: [leg.socket], signal: controller.signal });
    const outcome = pair("qr", d);
    await vi.waitFor(() => expect(phases.at(-1)).toEqual({ phase: "connecting" }));
    controller.abort();
    expect(await outcome).toEqual({ outcome: "cancelled" });
    expect(leg.isClosed()).toBe(true);
  });
});

describe("what the desk calls this phone", () => {
  it("reads the webview's user agent", () => {
    expect(
      deviceNameFrom(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
      )
    ).toBe("iPhone");
    expect(deviceNameFrom("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("iPad");
    expect(
      deviceNameFrom(
        "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP31.250502.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/136.0.0.0 Mobile Safari/537.36"
      )
    ).toBe("Pixel 9");
    expect(deviceNameFrom("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36")).toBe("Android phone");
    expect(deviceNameFrom("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Phone");
  });
});
