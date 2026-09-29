// The Companion core, as the shell's web layer runs it (spec, "The
// Companion shell": "the Companion core runs in the shell as WASM").
//
// The module is `crates/companion-wasm`, built by `scripts/core.mjs` into
// `static/companion-core.wasm`. It imports nothing, exports a way to hand
// it bytes, one function that answers a JSON call, and a way to read the
// answer (that crate's docs have the calls). Everything the wire needs --
// the handshake, the framing, the six digits, the Relay's hello -- is
// computed there, by the same Rust the daemon and the test Device run;
// this file only carries calls across.
//
// **One exchange, one instance.** `CoreModule.exchange()` instantiates the
// module afresh. A trap (a panic, on that target) ends the exchange it
// happened in and nothing else, and no state crosses from one pairing to
// the next.
import { fromHex, toHex } from "$shell/keys/deviceKeys";

/// Why the core stopped: `CoreError` in `crates/companion-core`, by name,
/// plus `request` for a call it did not accept and `trapped` for a module
/// that stopped running.
export type CoreFailureKind =
  | "offer"
  | "entropy"
  | "wrong-workstation"
  | "hardware-key"
  | "handshake"
  | "frame"
  | "not-ready"
  | "finished"
  | "request"
  | "trapped";

export class CoreError extends Error {
  constructor(
    readonly kind: CoreFailureKind,
    message: string
  ) {
    super(message);
    this.name = "CoreError";
  }
}

/// A Relay to dial, and the text frame to open with.
export interface RelayDial {
  url: string;
  hello: string;
}

export interface PairingStart {
  /// The handshake's first message, held until the Relay says the
  /// Workstation is there.
  send: Uint8Array;
  /// The Relays the QR names that this build may dial, in order.
  dials: RelayDial[];
  /// The Workstation's Noise public key, hex, as the QR pinned it.
  workstationKey: string;
}

/// What the shell keeps about a Workstation the desk paired it with: the
/// core's `PairedWorkstation`.
export interface KeptWorkstation {
  workstationKey: string;
  relays: string[];
  relayAdmission: string | null;
  deviceId: string;
  /// What the Workstation seals this Device's notifications with. Secret.
  notificationKey: string;
}

export type PairingEvent =
  | { type: "send"; bytes: Uint8Array }
  /// Have the hardware key sign this hash (hex). The native plugin adds
  /// the unlock prefix itself.
  | { type: "prove"; handshakeHash: string }
  | { type: "compare-code"; code: string }
  | { type: "finished"; verdict: "paired"; workstation: KeptWorkstation }
  | { type: "finished"; verdict: "rejected" | "expired" | "unknown" };

export type RelayReplyReading =
  | { reply: "ready" }
  | { reply: "refused"; reason: string; message: string }
  | { reply: "other" };

export interface CoreExchange {
  pairingStart(options: {
    qr: string;
    noisePrivateKey: string;
    hardwareKey: string;
    deviceName: string;
    /// Fresh random bytes, at least `PAIRING_ENTROPY` of them.
    entropy: Uint8Array;
  }): PairingStart;
  pairingReceive(bytes: Uint8Array): PairingEvent[];
  /// The hardware's signature, ASN.1 DER, hex.
  pairingProve(signature: string): PairingEvent[];
  relayReply(text: string): RelayReplyReading;
}

export interface CoreModule {
  exchange(): Promise<CoreExchange>;
}

/// How many random bytes a pairing handshake draws: `PAIRING_ENTROPY`.
export const PAIRING_ENTROPY = 32;

interface Exports {
  memory: WebAssembly.Memory;
  gavin_alloc(len: number): number;
  gavin_call(ptr: number, len: number): number;
  gavin_output(): number;
}

type Answer = { ok: unknown } | { error: { kind: CoreFailureKind; message: string } };

/// Compiles the module once; each exchange instantiates it.
export async function loadCore(bytes: BufferSource): Promise<CoreModule> {
  const module = await WebAssembly.compile(bytes);
  return {
    // Asynchronous, because Chromium (Android's WebView) refuses to
    // instantiate a module this size synchronously on the main thread.
    exchange: async () => exchangeOver((await WebAssembly.instantiate(module, {})).exports as unknown as Exports),
  };
}

function exchangeOver(exports: Exports): CoreExchange {
  let trapped: string | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const call = (request: Record<string, unknown>): unknown => {
    if (trapped !== null) throw new CoreError("trapped", trapped);
    const input = encoder.encode(JSON.stringify(request));
    let answer: Answer;
    try {
      const ptr = exports.gavin_alloc(input.length);
      new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
      const len = exports.gavin_call(ptr, input.length);
      // Read after the call: the memory may have grown under it, and the
      // view taken before would be of the old buffer.
      answer = JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, exports.gavin_output(), len).slice()));
    } catch (e) {
      trapped = `the Companion core stopped: ${e instanceof Error ? e.message : String(e)}`;
      throw new CoreError("trapped", trapped);
    } finally {
      // What was sent can hold the Device's Noise key; the module wipes
      // its own copy, and this is the only other.
      input.fill(0);
    }
    if ("error" in answer) throw new CoreError(answer.error.kind, answer.error.message);
    return answer.ok;
  };

  const events = (answer: unknown): PairingEvent[] =>
    (answer as { events: Array<Record<string, unknown>> }).events.map((event) =>
      event.type === "send" ? { type: "send", bytes: bytes(event.bytes as string) } : (event as PairingEvent)
    );

  return {
    pairingStart({ qr, noisePrivateKey, hardwareKey, deviceName, entropy }) {
      const started = call({
        op: "pairing-start",
        qr,
        noisePrivateKey,
        hardwareKey,
        deviceName,
        entropy: toHex(entropy),
      }) as { send: string; dials: RelayDial[]; workstationKey: string };
      return { send: bytes(started.send), dials: started.dials, workstationKey: started.workstationKey };
    },
    pairingReceive: (arrived) => events(call({ op: "pairing-receive", bytes: toHex(arrived) })),
    pairingProve: (signature) => events(call({ op: "pairing-prove", signature })),
    relayReply: (text) => call({ op: "relay-reply", text }) as RelayReplyReading,
  };
}

function bytes(hex: string): Uint8Array {
  const out = fromHex(hex);
  if (!out) throw new CoreError("request", "the Companion core answered with bytes that are not hex");
  return out;
}
