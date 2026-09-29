// Pairing, as the Device runs it: from a scanned code to the desk's answer
// (spec, "Pairing and the trust store"; `docs/security/05-remote-access.md`
// §3 for the ceremony).
//
// 1. The Device's keys: refused on a phone that cannot be a Device, made
//    on the first pairing, read on every one after.
// 2. The core reads the code and prepares the handshake -- before anything
//    is dialled, so a code that cannot pair costs no connection.
// 3. The first Relay the code names that answers `ready` carries the
//    handshake, with the code's admission token in the hello.
// 4. After the handshake the hardware key signs it (the owner is asked),
//    and the proof -- the signature and the hardware public key, which is
//    what pairing registers -- goes to the Workstation.
// 5. Once the Workstation has taken the proof, the six digits are shown,
//    for the human to compare with the desk's.
// 6. The desk rules. Only `paired` leaves anything to keep.
//
// Every byte of the wire is the core's; this module sequences it, and says
// what went wrong in words for the human holding the phone.
import {
  CoreError,
  PAIRING_ENTROPY,
  type CoreExchange,
  type CoreModule,
  type KeptWorkstation,
  type PairingEvent,
  type PairingStart,
} from "$shell/core/core";
import { errorCode, readiness, refusalText, type Refusal } from "$shell/keys/deviceKeys";
import type { DeviceKeysPlugin } from "$shell/native/deviceKeys";
import { RelayLegError, type OpenRelaySocket, type RelaySocket } from "$shell/pairing/relaySocket";

export type PairingKeys = Pick<DeviceKeysPlugin, "status" | "createKeys" | "publicKeys" | "noiseKey" | "sign">;

/// Where a pairing is, for the sheet to say.
export type PairingPhase =
  | { phase: "preparing" }
  | { phase: "connecting" }
  /// The owner is being asked to confirm on the phone.
  | { phase: "confirming" }
  /// The six digits are on screen; the desk is being asked.
  | { phase: "comparing"; code: string };

export type PairingOutcome =
  | { outcome: "paired"; workstation: KeptWorkstation }
  | { outcome: "failed"; problem: string }
  | { outcome: "cancelled" };

export interface PairingTimeouts {
  /// Opening a Relay and hearing its reply.
  relayMs: number;
  /// Each handshake message, up to the code.
  stepMs: number;
  /// The desk's answer, once the code is on screen. The desk's offer
  /// lapses well before this, and the Workstation then says `expired`.
  deskMs: number;
}

export const PAIRING_TIMEOUTS: PairingTimeouts = { relayMs: 20_000, stepMs: 20_000, deskMs: 5 * 60_000 };

/// What the owner's prompt says when the hardware key signs the pairing.
export const PAIRING_SIGN_REASON = "Pair this phone with your Workstation";

export interface PairingDeps {
  core: CoreModule;
  keys: PairingKeys;
  open: OpenRelaySocket;
  /// Cryptographic randomness: `crypto.getRandomValues`.
  random(length: number): Uint8Array;
  /// What the desk shows beside Confirm.
  deviceName: string;
  onPhase(phase: PairingPhase): void;
  signal?: AbortSignal;
  timeouts?: Partial<PairingTimeouts>;
}

/// A pairing that stopped, and what to tell the human.
class Stop extends Error {
  constructor(readonly outcome: Exclude<PairingOutcome, { outcome: "paired" }>) {
    super("stopped");
  }
}

const failed = (problem: string): Stop => new Stop({ outcome: "failed", problem });

export async function pair(qr: string, deps: PairingDeps): Promise<PairingOutcome> {
  const timeouts = { ...PAIRING_TIMEOUTS, ...deps.timeouts };
  let socket: RelaySocket | null = null;
  const onAbort = (): void => socket?.close();
  deps.signal?.addEventListener("abort", onAbort);
  try {
    deps.onPhase({ phase: "preparing" });
    const keys = await deviceKeys(deps.keys);
    checkAborted(deps.signal);

    const exchange = await deps.core.exchange();
    const entropy = deps.random(PAIRING_ENTROPY);
    let started: PairingStart;
    try {
      started = coreStep(() =>
        exchange.pairingStart({
          qr,
          noisePrivateKey: keys.noisePrivateKey,
          hardwareKey: keys.hardwareKey,
          deviceName: deps.deviceName,
          entropy,
        })
      );
    } finally {
      // Handed over or refused, it is this handshake's and no other's.
      entropy.fill(0);
    }
    if (started.dials.length === 0) {
      throw failed(
        "This pairing code names no Relay the phone can reach. Turn on remote access at the desk, with a Relay, and show a new code."
      );
    }

    deps.onPhase({ phase: "connecting" });
    socket = await dialFirst(started.dials, exchange.relayReply, deps, timeouts.relayMs, (trying) => {
      socket = trying;
    });
    socket.send(started.send);

    const pending: PairingEvent[] = [];
    let atDesk = false;
    for (;;) {
      for (let event = pending.shift(); event; event = pending.shift()) {
        switch (event.type) {
          case "send":
            socket.send(event.bytes);
            break;
          case "prove": {
            deps.onPhase({ phase: "confirming" });
            const signature = await sign(deps.keys, event.handshakeHash);
            checkAborted(deps.signal);
            deps.onPhase({ phase: "connecting" });
            pending.push(...coreStep(() => exchange.pairingProve(signature)));
            break;
          }
          case "compare-code":
            atDesk = true;
            deps.onPhase({ phase: "comparing", code: event.code });
            break;
          case "finished":
            if (event.verdict === "paired") return { outcome: "paired", workstation: event.workstation };
            throw failed(VERDICTS[event.verdict]);
        }
      }
      const message = await socket.next(atDesk ? timeouts.deskMs : timeouts.stepMs).catch((e) => {
        checkAborted(deps.signal);
        throw legFailure(e, atDesk);
      });
      if (message.kind !== "bytes") {
        throw failed("The Relay sent something that is not part of the pairing. Nothing was paired.");
      }
      pending.push(...coreStep(() => exchange.pairingReceive(message.bytes)));
    }
  } catch (e) {
    if (deps.signal?.aborted) return { outcome: "cancelled" };
    if (e instanceof Stop) return e.outcome;
    return { outcome: "failed", problem: `The pairing stopped: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    deps.signal?.removeEventListener("abort", onAbort);
    socket?.close();
  }
}

const VERDICTS: Record<"rejected" | "expired" | "unknown", string> = {
  rejected: "The desk declined this pairing. Nothing was paired.",
  expired: "Nobody confirmed at the desk in time. Show a new code there and scan it again.",
  unknown: "The Workstation answered in a way this Companion does not understand. Update the Companion and pair again.",
};

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Stop({ outcome: "cancelled" });
}

interface ReadKeys {
  hardwareKey: string;
  noisePrivateKey: string;
}

/// The Device's keys: made on the first pairing, and the same for every
/// Workstation after it (spec, "Pairing and trust" story 5).
async function deviceKeys(keys: PairingKeys): Promise<ReadKeys> {
  try {
    const status = await keys.status();
    const ready = readiness(status);
    if (!ready.ready) throw failed(refusalText(ready.refusal));
    const made = status.keys ? await keys.publicKeys() : await keys.createKeys();
    const { privateKey } = await keys.noiseKey();
    return { hardwareKey: made.hardwareKey, noisePrivateKey: privateKey };
  } catch (e) {
    if (e instanceof Stop) throw e;
    const code = errorCode(e);
    if (code === "no-passcode" || code === "no-hardware-keystore") throw failed(refusalText(code as Refusal));
    throw failed(`This phone’s keys could not be used: ${message(e)}`);
  }
}

async function sign(keys: PairingKeys, handshakeHash: string): Promise<string> {
  try {
    return (await keys.sign({ handshakeHash, reason: PAIRING_SIGN_REASON })).signature;
  } catch (e) {
    const code = errorCode(e);
    if (code === "cancelled") throw failed("You did not confirm on this phone, so nothing was paired.");
    if (code === "no-passcode") throw failed(refusalText("no-passcode"));
    throw failed(`This phone could not sign the pairing: ${message(e)}`);
  }
}

/// The first Relay that says the Workstation is there, with its hello
/// answered `ready`. A Relay that cannot be reached, or refuses, is
/// passed over for the next; the last reason is the one told.
async function dialFirst(
  dials: Array<{ url: string; hello: string }>,
  readReply: CoreExchange["relayReply"],
  deps: PairingDeps,
  timeoutMs: number,
  track: (socket: RelaySocket) => void
): Promise<RelaySocket> {
  let problem = "";
  for (const dial of dials) {
    checkAborted(deps.signal);
    let socket: RelaySocket;
    try {
      socket = await deps.open(dial.url, timeoutMs);
      track(socket);
      if (deps.signal?.aborted) socket.close();
      checkAborted(deps.signal);
    } catch (e) {
      if (e instanceof Stop) throw e;
      problem = `Could not reach the Relay at ${dial.url}. Check that this phone is online, and that the Relay is running.`;
      if (!(e instanceof RelayLegError)) problem += ` (${message(e)})`;
      continue;
    }
    try {
      socket.send(dial.hello);
      const reply = await socket.next(timeoutMs);
      if (reply.kind === "text") {
        const read = coreStep(() => readReply(reply.text));
        if (read.reply === "ready") return socket;
        problem =
          read.reply === "refused"
            ? `The Relay turned the pairing away: ${read.message}.${read.reason === "offline" ? " Is remote access still on at the desk?" : ""}`
            : `The Relay at ${dial.url} answered in a way this Companion does not understand.`;
      } else {
        problem = `The Relay at ${dial.url} did not answer as a Relay does.`;
      }
    } catch (e) {
      if (e instanceof Stop) throw e;
      checkAborted(deps.signal);
      problem = `The Relay at ${dial.url} did not answer: ${message(e)}.`;
    }
    socket.close();
  }
  throw failed(problem);
}

/// A call to the core, whose refusal is said in the core's own words:
/// they were written for the human holding the phone.
function coreStep<T>(step: () => T): T {
  try {
    return step();
  } catch (e) {
    if (e instanceof CoreError) throw failed(sentence(e.message));
    throw e;
  }
}

function legFailure(e: unknown, atDesk: boolean): Stop {
  if (e instanceof RelayLegError && e.failure === "timeout") {
    return failed(
      atDesk
        ? "Nobody confirmed at the desk in time. Show a new code there and scan it again."
        : "The Workstation did not answer in time. Nothing was paired."
    );
  }
  return failed(
    atDesk
      ? "The Workstation stopped waiting for the desk. Nothing was paired."
      : "The Workstation ended the pairing before the codes could be compared. The code may have lapsed, or been used already: show a new one at the desk and scan it again."
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/// What the desk calls this phone, from what the webview says it is. An
/// iPhone says only "iPhone" (iOS no longer tells an app the name its
/// owner gave it); an Android WebView names the model.
export function deviceNameFrom(userAgent: string): string {
  if (/\biPad\b/.test(userAgent)) return "iPad";
  if (/\biPhone\b/.test(userAgent)) return "iPhone";
  const android = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent);
  if (android && android[1].trim() && android[1].trim() !== "K") return android[1].trim();
  if (/\bAndroid\b/.test(userAgent)) return "Android phone";
  return "Phone";
}
