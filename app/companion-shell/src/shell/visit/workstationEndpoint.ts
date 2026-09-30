// A paired Workstation's end of the bundle channel (ADR 0003, ADR 0005):
// what the bundle's `invoke`, `listen` and `unlisten` become on the
// Device wire, and how a desktop event comes back as an `event`.
//
// The channel's messages go over the live hub's connection to that
// Workstation -- the same one the hub asks what is waiting on -- through
// the daemon's forwarding to the desktop app:
//
// | from the bundle | on the wire | back to the bundle |
// |---|---|---|
// | `invoke` | `InvokeDesktop { command, args }` | `result` with the `DesktopResult`'s value, or its error |
// | `listen` | `ListenDesktop { event }`, once per event name | `result`, once the daemon has it |
// | `unlisten` | `UnlistenDesktop { event }`, when its last listener goes | `result` |
// | (a push) | `DesktopEvent { event, payload }` | `event` to each listener of that name |
//
// The connection comes and goes with the Unlock and the network. A call
// made while there is none is answered with an error the bundle shows,
// never dropped; and when a connection comes back, every event still
// listened for is listened for again on it, since the daemon keeps a
// listen per connection and the new one has none.
import { CHANNEL_VERSION, encode, readBundleMessage, type BundleMessage } from "$companion/channel/messages";
import type { ChannelEndpoint } from "$companion/channel/port";
import type { Connection } from "$shell/connection/connection";
import type { VisitEndpoint } from "$shell/visit/visit";

/// Where a visit gets its Workstation's connection: the live hub.
export interface ConnectionSource {
  current(): Connection | null;
  /// Hears each connection as it comes, and `null` as it goes. Returns
  /// how to stop hearing.
  subscribe(listener: (connection: Connection | null) => void): () => void;
}

/// How long a forwarded command may take. The daemon gives the desktop
/// sixty seconds; this waits a little past that, so the daemon's own
/// answer -- "desktop app not running" -- is the one the bundle sees.
export const INVOKE_TIMEOUT_MS = 65_000;

/// A `ListenDesktop` or `UnlistenDesktop`: answered from the daemon
/// itself, at once.
export const LISTEN_TIMEOUT_MS = 15_000;

export const NOT_CONNECTED = "The Workstation cannot be reached right now.";

interface Options {
  log?(line: string): void;
  invokeTimeoutMs?: number;
  listenTimeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/// What a daemon answers a request with, read as the bundle's error
/// string when it is not the value asked for.
function isAnswer(reply: unknown): reply is Record<string, unknown> {
  return isObject(reply) && typeof reply.type === "string" && reply.type !== "DesktopEvent";
}

export function workstationEndpoint(source: ConnectionSource, options: Options = {}): VisitEndpoint {
  const log = options.log ?? (() => {});
  const invokeTimeoutMs = options.invokeTimeoutMs ?? INVOKE_TIMEOUT_MS;
  const listenTimeoutMs = options.listenTimeoutMs ?? LISTEN_TIMEOUT_MS;
  /// The bundle's listeners: the `listen`'s id, and the event it named.
  const listeners = new Map<number, string>();
  /// How to reach the bundle: the reply of the last message received.
  let reply: ((raw: string) => void) | null = null;
  /// Stops hearing the current connection's pushes.
  let stopPushes: (() => void) | null = null;
  let stopped = false;

  const ok = (id: number, value: unknown = null): void =>
    reply?.(encode({ v: CHANNEL_VERSION, type: "result", id, ok: true, value }));
  const fail = (id: number, error: string): void =>
    reply?.(encode({ v: CHANNEL_VERSION, type: "result", id, ok: false, error }));

  /// The event names with at least one listener.
  const listened = (): Set<string> => new Set(listeners.values());

  const onPush = (message: unknown): void => {
    if (!isObject(message) || message.type !== "DesktopEvent" || typeof message.event !== "string") return;
    const event = message.event;
    const payload = message.payload ?? null;
    for (const [listener, name] of listeners) {
      if (name === event) reply?.(encode({ v: CHANNEL_VERSION, type: "event", listener, event, payload }));
    }
  };

  /// A daemon's answer to a listen or an unlisten, as the bundle hears
  /// it.
  const settled = (id: number, request: Promise<unknown>): void => {
    request.then(
      (answer) => {
        if (isObject(answer) && answer.type === "Ok") ok(id);
        else fail(id, problemOf(answer));
      },
      (e) => fail(id, e instanceof Error ? e.message : String(e))
    );
  };

  const listenOn = (connection: Connection, event: string): Promise<unknown> =>
    connection.request({ type: "ListenDesktop", event }, isAnswer, listenTimeoutMs);

  const hear = (connection: Connection | null): void => {
    stopPushes?.();
    stopPushes = null;
    if (!connection || stopped) return;
    stopPushes = connection.onPush(onPush);
    // The daemon keeps a listen per connection: a new connection has to
    // be told again what the bundle listens for.
    for (const event of listened()) {
      void listenOn(connection, event).catch((e) => log(`[gavin-visit] could not listen for ${event} again: ${e}`));
    }
  };

  function receive(message: BundleMessage): void {
    switch (message.type) {
      case "invoke": {
        const connection = source.current();
        if (!connection) {
          fail(message.id, NOT_CONNECTED);
          return;
        }
        connection
          .request({ type: "InvokeDesktop", command: message.cmd, args: message.args }, isAnswer, invokeTimeoutMs)
          .then(
            (answer) => {
              if (isObject(answer) && answer.type === "DesktopResult") {
                if (typeof answer.error === "string") fail(message.id, answer.error);
                else ok(message.id, answer.value === undefined ? null : answer.value);
              } else {
                fail(message.id, problemOf(answer));
              }
            },
            (e) => fail(message.id, e instanceof Error ? e.message : String(e))
          );
        return;
      }
      case "listen": {
        const first = !listened().has(message.event);
        listeners.set(message.id, message.event);
        const connection = source.current();
        if (!first) {
          ok(message.id);
          return;
        }
        if (!connection) {
          // Listened for as soon as a connection comes; the bundle can
          // register now, and hears events once the Workstation is back.
          ok(message.id);
          return;
        }
        settled(message.id, listenOn(connection, message.event));
        return;
      }
      case "unlisten": {
        const event = listeners.get(message.listener);
        listeners.delete(message.listener);
        const connection = source.current();
        if (event === undefined || listened().has(event) || !connection) {
          ok(message.id);
          return;
        }
        settled(message.id, connection.request({ type: "UnlistenDesktop", event }, isAnswer, listenTimeoutMs));
        return;
      }
      default:
        // `capabilities`, `open-external` and `return-to-hub` are the
        // shell's own and never reach a Workstation's end.
        fail(message.id, `${message.type} is not the Workstation's to answer`);
    }
  }

  const endpoint: ChannelEndpoint = {
    receive(raw, replyTo) {
      reply = replyTo;
      const read = readBundleMessage(raw);
      if (read.kind === "message") receive(read.message);
      else if (read.id !== null) fail(read.id, read.kind === "unknown" ? `${read.type} is not a message this end carries` : read.reason);
    },
  };

  return {
    endpoint,
    start() {
      stopped = false;
      const unsubscribe = source.subscribe(hear);
      hear(source.current());
      return () => {
        stopped = true;
        unsubscribe();
        stopPushes?.();
        stopPushes = null;
        // The listens are this visit's: the daemon drops them with the
        // connection, and a connection that stays needs them ended.
        const connection = source.current();
        if (connection) {
          for (const event of listened()) {
            void connection.request({ type: "UnlistenDesktop", event }, isAnswer, listenTimeoutMs).catch(() => {});
          }
        }
        listeners.clear();
        reply = null;
      };
    },
  };
}

/// The daemon's refusal, in words the bundle can show.
export function problemOf(answer: unknown): string {
  if (!isObject(answer)) return "The Workstation's answer is not one this Companion reads.";
  switch (answer.type) {
    case "Error":
      return typeof answer.message === "string" ? answer.message : "The Workstation refused.";
    case "Forbidden":
      return `The Workstation does not let a phone ${typeof answer.request_type === "string" ? answer.request_type : "do that"}.`;
    case "Unsupported":
      return "The Workstation's Gavin is too old for this. Update Gavin at the desk.";
    default:
      return `The Workstation answered with ${String(answer.type)}, which this Companion does not read.`;
  }
}
