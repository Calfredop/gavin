// A connection to a paired Workstation, as the Device opens it (spec, "The
// Device's keys and the Unlock"; ADR 0001 for what follows the handshake).
//
// 1. The core prepares the `IK` handshake to the key pinned at pairing,
//    and names the Relays the Workstation gave, before anything is dialled.
// 2. The first Relay that answers `ready` carries the stream. One that
//    says `offline` has no Workstation registered under that key: the Mac
//    is asleep, or remote access is off at the desk (spec, "The attention
//    request": asleep is inferred from the Relay).
// 3. After the handshake the hardware key signs its hash under the Unlock,
//    without asking the owner: the Unlock asked once, when the Companion
//    came to the front, and that is what lets a reconnect -- and every
//    other Workstation's connection -- go through without a prompt
//    (ADR 0004).
// 4. The Workstation verifies the proof and says `connected`, or refuses.
// 5. Then the daemon's own protocol, a JSON message a line, one request
//    at a time.
//
// Every byte of the wire is the core's; this module sequences it, and
// names each way it can end for the hub to show.
import {
  CONNECT_ENTROPY,
  CoreError,
  type ConnectEvent,
  type ConnectRefusal,
  type ConnectStart,
  type CoreExchange,
  type CoreModule,
  type KeptWorkstation,
  type RelayDial,
} from "$shell/core/core";
import { errorCode } from "$shell/keys/deviceKeys";
import type { DeviceKeysPlugin, UnlockPlugin } from "$shell/native/deviceKeys";
import { RelayLegError, type OpenRelaySocket, type RelaySocket } from "$shell/pairing/relaySocket";

export type ConnectionKeys = Pick<DeviceKeysPlugin, "noiseKey"> & Pick<UnlockPlugin, "signUnlocked">;

/// What the shell kept at pairing that a connection needs.
export type ConnectTarget = Pick<KeptWorkstation, "workstationKey" | "relays" | "relayAdmission">;

export type ConnectOutcome =
  | { outcome: "connected"; connection: Connection; deviceId: string }
  /// A Relay answered and holds no Workstation under that key: asleep, or
  /// remote access is off at the desk.
  | { outcome: "asleep" }
  /// No Relay carried the stream, or the stream failed on its way.
  | { outcome: "unreachable"; problem: string }
  /// The Workstation refused this Device. `reason` says whether trying
  /// again can help (`refusalIsFinal`).
  | { outcome: "refused"; reason: ConnectRefusal; problem: string }
  /// No Unlock is held: the connection was not made.
  | { outcome: "locked" }
  /// The Unlock no longer covers a new connection (Android's auth window
  /// closed). A new Unlock opens it again; connections already open are
  /// unaffected (ADR 0004).
  | { outcome: "lapsed" }
  /// Something on this phone failed: its keys, or the core.
  | { outcome: "failed"; problem: string };

export interface ConnectionTimeouts {
  /// Opening a Relay and hearing its reply.
  relayMs: number;
  /// Each handshake message, and the verdict.
  stepMs: number;
}

export const CONNECTION_TIMEOUTS: ConnectionTimeouts = { relayMs: 15_000, stepMs: 15_000 };

export interface ConnectDeps {
  core: CoreModule;
  keys: ConnectionKeys;
  open: OpenRelaySocket;
  /// Cryptographic randomness: `crypto.getRandomValues`.
  random(length: number): Uint8Array;
  signal?: AbortSignal;
  timeouts?: Partial<ConnectionTimeouts>;
}

/// A connection the Workstation has given the Remote role.
export interface Connection {
  /// Sends one message of the daemon's protocol and resolves with the
  /// first message back that `answers` accepts; anything before it that
  /// it does not accept is passed over. One request at a time: a second
  /// waits for the first.
  request(message: unknown, answers: (reply: unknown) => boolean, timeoutMs: number): Promise<unknown>;
  /// Hears every message the Workstation sends that no request was
  /// waiting for: its pushes (`DesktopEvent` for a listened event, and
  /// whatever else the daemon pushes to a Device). Returns how to stop
  /// listening. With nobody listening such a message is kept for the
  /// next request to pass over, as before.
  onPush(handler: (message: unknown) => void): () => void;
  /// Hangs up. `closed` then settles.
  close(why?: string): void;
  /// Settles, with why, once the stream has ended for any reason.
  readonly closed: Promise<string>;
  readonly isClosed: boolean;
}

/// Refusals that trying again cannot change: this Device has no row the
/// Workstation will connect with, and pairing again is the way back.
export function refusalIsFinal(reason: ConnectRefusal): boolean {
  return reason === "not-paired" || reason === "revoked" || reason === "stale" || reason === "pair-again";
}

class Ended extends Error {
  constructor(readonly outcome: Exclude<ConnectOutcome, { outcome: "connected" }>) {
    super(outcome.outcome);
  }
}

const unreachable = (problem: string): Ended => new Ended({ outcome: "unreachable", problem });

export async function connect(target: ConnectTarget, deps: ConnectDeps): Promise<ConnectOutcome> {
  const timeouts = { ...CONNECTION_TIMEOUTS, ...deps.timeouts };
  let socket: RelaySocket | null = null;
  let handedOver = false;
  const onAbort = (): void => socket?.close();
  deps.signal?.addEventListener("abort", onAbort);
  try {
    const exchange = await deps.core.exchange();
    let noisePrivateKey: string;
    try {
      ({ privateKey: noisePrivateKey } = await deps.keys.noiseKey());
    } catch (e) {
      throw new Ended({ outcome: "failed", problem: keysProblem(e) });
    }
    const entropy = deps.random(CONNECT_ENTROPY);
    let started: ConnectStart;
    try {
      started = coreStep(() =>
        exchange.connectStart({
          workstationKey: target.workstationKey,
          relays: target.relays,
          relayAdmission: target.relayAdmission,
          noisePrivateKey,
          entropy,
        })
      );
    } finally {
      // Handed over or refused, it is this handshake's and no other's.
      entropy.fill(0);
    }
    if (started.dials.length === 0) {
      throw new Ended({ outcome: "failed", problem: "It names no Relay this phone may dial. Pair it again." });
    }

    socket = await dialFirst(started.dials, exchange, deps, timeouts.relayMs, (trying) => {
      socket = trying;
    });
    socket.send(started.send);

    const pending: ConnectEvent[] = [];
    const early: string[] = [];
    for (;;) {
      for (let event = pending.shift(); event; event = pending.shift()) {
        switch (event.type) {
          case "send":
            socket.send(event.bytes);
            break;
          case "prove": {
            const signature = await signUnlocked(deps.keys, event.handshakeHash);
            checkAborted(deps.signal);
            pending.push(...coreStep(() => exchange.connectProve(signature)));
            break;
          }
          case "connected": {
            // What came in the same read as the verdict is the stream's.
            for (const rest of pending.splice(0)) if (rest.type === "message") early.push(rest.text);
            const connection = liveConnection(exchange, socket, early);
            handedOver = true;
            return { outcome: "connected", connection, deviceId: event.deviceId };
          }
          case "refused":
            throw new Ended({ outcome: "refused", reason: event.reason, problem: sentence(event.message) });
          case "message":
            // Not before the verdict; kept for the connection if one
            // comes in the same read.
            early.push(event.text);
            break;
        }
      }
      const message = await socket.next(timeouts.stepMs).catch((e) => {
        checkAborted(deps.signal);
        throw e instanceof RelayLegError && e.failure === "timeout"
          ? unreachable("It did not answer in time.")
          : unreachable("It ended the connection before it was made.");
      });
      if (message.kind !== "bytes") throw unreachable("Its Relay sent something that is not part of the connection.");
      pending.push(...coreStep(() => exchange.connectReceive(message.bytes)));
    }
  } catch (e) {
    if (deps.signal?.aborted) return { outcome: "unreachable", problem: "The connection was stopped." };
    if (e instanceof Ended) return e.outcome;
    return { outcome: "failed", problem: `The connection stopped: ${messageOf(e)}` };
  } finally {
    deps.signal?.removeEventListener("abort", onAbort);
    if (!handedOver) socket?.close();
  }
}

/// The Relays in order, until one says the Workstation is there. When
/// none does, a Relay that answered `offline` makes the Workstation
/// asleep; otherwise it is unreachable, for the last reason heard.
async function dialFirst(
  dials: RelayDial[],
  exchange: CoreExchange,
  deps: ConnectDeps,
  timeoutMs: number,
  track: (socket: RelaySocket) => void
): Promise<RelaySocket> {
  let asleep = false;
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
      if (e instanceof Ended) throw e;
      problem = `Could not reach its Relay at ${dial.url}. Check that this phone is online.`;
      continue;
    }
    try {
      socket.send(dial.hello);
      const reply = await socket.next(timeoutMs);
      if (reply.kind === "text") {
        const read = coreStep(() => exchange.relayReply(reply.text));
        if (read.reply === "ready") return socket;
        if (read.reply === "refused" && read.reason === "offline") asleep = true;
        else if (read.reply === "refused") problem = `Its Relay turned the connection away: ${read.message}.`;
        else problem = `Its Relay at ${dial.url} answered in a way this Companion does not understand.`;
      } else {
        problem = `Its Relay at ${dial.url} did not answer as a Relay does.`;
      }
    } catch (e) {
      if (e instanceof Ended) throw e;
      checkAborted(deps.signal);
      problem = `Its Relay at ${dial.url} did not answer: ${messageOf(e)}.`;
    }
    socket.close();
  }
  if (asleep) throw new Ended({ outcome: "asleep" });
  throw unreachable(problem);
}

async function signUnlocked(keys: ConnectionKeys, handshakeHash: string): Promise<string> {
  try {
    return (await keys.signUnlocked({ handshakeHash })).signature;
  } catch (e) {
    const code = errorCode(e);
    if (code === "locked") throw new Ended({ outcome: "locked" });
    if (code === "unlock-expired") throw new Ended({ outcome: "lapsed" });
    throw new Ended({ outcome: "failed", problem: keysProblem(e) });
  }
}

function keysProblem(e: unknown): string {
  return errorCode(e) === "no-keys"
    ? "This phone no longer holds its Device keys. Pair it again."
    : `This phone could not sign the connection: ${messageOf(e)}`;
}

/// The stream after `connected`: a pump that reads it for as long as it
/// lasts, and requests answered one at a time.
function liveConnection(exchange: CoreExchange, socket: RelaySocket, early: string[]): Connection {
  const inbox: string[] = [...early];
  /// The request waiting for its answer, if one is.
  let waiter: { answers(reply: unknown): boolean; resolve(reply: unknown): void } | null = null;
  const pushHandlers = new Set<(message: unknown) => void>();
  let isClosed = false;
  let settle!: (why: string) => void;
  const closed = new Promise<string>((resolve) => (settle = resolve));
  /// Rejects whoever is waiting when the stream ends.
  let failWaiter: ((why: string) => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const end = (why: string): void => {
    if (isClosed) return;
    isClosed = true;
    socket.close();
    failWaiter?.(why);
    settle(why);
  };

  /// A message from the Workstation: the answer the waiting request
  /// wants, else a push for whoever listens, else kept for the next
  /// request to look at.
  const deliver = (text: string): void => {
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      return;
    }
    if (waiter?.answers(reply)) {
      waiter.resolve(reply);
      return;
    }
    if (pushHandlers.size > 0) {
      for (const handler of [...pushHandlers]) handler(reply);
      return;
    }
    inbox.push(text);
  };

  void (async () => {
    // A long wait, taken again while nothing is wrong: silence is not a
    // failure here. A dead network is found by a request timing out.
    const PUMP_MS = 60_000;
    while (!isClosed) {
      let message;
      try {
        message = await socket.next(PUMP_MS);
      } catch (e) {
        if (e instanceof RelayLegError && e.failure === "timeout") continue;
        end("The Workstation ended the connection.");
        return;
      }
      if (message.kind !== "bytes") {
        end("Its Relay sent something that is not part of the connection.");
        return;
      }
      let events: ConnectEvent[];
      try {
        events = exchange.connectReceive(message.bytes);
      } catch (e) {
        end(`The connection broke: ${messageOf(e)}`);
        return;
      }
      for (const event of events) {
        if (event.type === "message") deliver(event.text);
        else if (event.type === "send") socket.send(event.bytes);
      }
    }
  })();

  const once = (message: unknown, answers: (reply: unknown) => boolean, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (isClosed) {
        reject(new Error("the connection is closed"));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (timer !== null) clearTimeout(timer);
        waiter = null;
        failWaiter = null;
      };
      const offer = (text: string): boolean => {
        let reply: unknown;
        try {
          reply = JSON.parse(text);
        } catch {
          return false;
        }
        if (!answers(reply)) return false;
        finish();
        resolve(reply);
        return true;
      };
      failWaiter = (why) => {
        finish();
        reject(new Error(why));
      };
      try {
        socket.send(exchange.connectSend(JSON.stringify(message)));
      } catch (e) {
        finish();
        end(`The connection broke: ${messageOf(e)}`);
        reject(e);
        return;
      }
      // What arrived before this request, then whatever arrives next.
      while (inbox.length > 0) if (offer(inbox.shift()!)) return;
      waiter = {
        answers,
        resolve: (reply) => {
          finish();
          resolve(reply);
        },
      };
      timer = setTimeout(() => {
        finish();
        reject(new Error("the Workstation did not answer in time"));
      }, timeoutMs);
    });

  return {
    request(message, answers, timeoutMs) {
      const run = queue.then(() => once(message, answers, timeoutMs));
      queue = run.catch(() => {});
      return run;
    },
    onPush(handler) {
      pushHandlers.add(handler);
      return () => {
        pushHandlers.delete(handler);
      };
    },
    close: (why = "The connection was closed.") => end(why),
    closed,
    get isClosed() {
      return isClosed;
    },
  };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw unreachable("The connection was stopped.");
}

/// A call to the core, whose refusal is said in the core's own words.
function coreStep<T>(step: () => T): T {
  try {
    return step();
  } catch (e) {
    if (e instanceof CoreError) {
      throw new Ended(
        e.kind === "trapped" || e.kind === "entropy" || e.kind === "request"
          ? { outcome: "failed", problem: sentence(e.message) }
          : { outcome: "unreachable", problem: sentence(e.message) }
      );
    }
    throw e;
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
