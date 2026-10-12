// The bundle's end of the channel: questions out, answers paired back by
// id, events handed to whoever listened for them.
//
// Nothing here knows what a command or an event MEANS. That is the point
// of ADR 0003 -- the desktop's own modules decide what to ask, and this
// only carries it.
import {
  CHANNEL_VERSION,
  CORE_MESSAGES,
  encode,
  readLanding,
  readWorkstationMessage,
  type BundleMessage,
  type Capabilities,
  type ConnectionState,
  type ErrorCode,
  type MessageType,
} from "$companion/channel/messages";
import type { ChannelPort } from "$companion/channel/port";

/// A request the other end did not carry out, in its own words.
export class ChannelError extends Error {
  readonly code: ErrorCode | null;

  constructor(message: string, code: ErrorCode | null = null) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
  }
}

export interface ChannelClient {
  /// What the other end carries, asked once and remembered. Never
  /// rejects: an end that cannot answer is an end carrying the core set.
  capabilities(): Promise<Capabilities>;
  supports(type: MessageType): Promise<boolean>;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /// Resolves once the other end has registered the listener, with its
  /// teardown.
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  /// Opens a web link in the system browser. `false` when it was not
  /// opened -- the shell does not know the message, refused the link, or
  /// the link is not a web link.
  openExternal(url: string): Promise<boolean>;
  /// Leaves this Workstation for the Workstations hub. `false` when the
  /// shell does not know the message, so the caller can hide the way out
  /// rather than offer a button that does nothing.
  returnToHub(): Promise<boolean>;
  /// Hears the connection to the Workstation go down and come back up,
  /// from a shell that says so. One older than `connection` says
  /// nothing, and this never fires. Returns how to stop hearing.
  onConnection(handler: (state: ConnectionState) => void): () => void;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: ChannelError) => void;
}

const CLOSED = "the channel closed";

/// What a bundle may assume when it could not find out.
function coreCapabilities(): Capabilities {
  return {
    version: CHANNEL_VERSION,
    messages: [...CORE_MESSAGES],
    workstation: { id: "", name: "", demo: false },
  };
}

function readCapabilities(value: unknown): Capabilities | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as Record<string, unknown>;
  if (typeof answer.version !== "number") return null;
  if (!Array.isArray(answer.messages) || !answer.messages.every((m) => typeof m === "string")) return null;
  const ws = answer.workstation as Record<string, unknown> | null | undefined;
  const read: Capabilities = {
    version: answer.version,
    messages: answer.messages,
    workstation: {
      id: typeof ws?.id === "string" ? ws.id : "",
      name: typeof ws?.name === "string" ? ws.name : "",
      demo: ws?.demo === true,
    },
  };
  const landing = readLanding(answer.landing);
  if (landing) read.landing = landing;
  return read;
}

/// Only a web link leaves the app. The shell checks too -- it is the one
/// that must -- but a bundle that never asks for `javascript:` cannot be
/// talked into it by a card's markdown either.
function isWebLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function createChannelClient(port: ChannelPort): ChannelClient {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  const listeners = new Map<number, (payload: unknown) => void>();
  const connectionHandlers = new Set<(state: ConnectionState) => void>();
  let asked: Promise<Capabilities> | null = null;

  const stopReceiving = port.receive((raw) => {
    const read = readWorkstationMessage(raw);
    if (read.kind === "malformed") {
      // A reply this build cannot read still ends the wait it was for:
      // a call left pending forever is a spinner nobody can dismiss.
      if (read.id !== null) settle(read.id, (p) => p.reject(new ChannelError(read.reason)));
      return;
    }
    // A type from a newer shell. Nothing here is waiting on it.
    if (read.kind === "unknown") return;
    const message = read.message;
    if (message.type === "connection") {
      const state: ConnectionState =
        message.state === "up" ? { state: "up" } : { state: "down", reason: message.reason };
      for (const handler of [...connectionHandlers]) {
        try {
          handler(state);
        } catch (e) {
          console.error("a connection handler threw", e);
        }
      }
      return;
    }
    if (message.type === "event") {
      const handler = listeners.get(message.listener);
      if (!handler) return;
      try {
        handler(message.payload);
      } catch (e) {
        // One surface's handler must not take the channel down with it.
        console.error(`the listener for "${message.event}" threw`, e);
      }
      return;
    }
    settle(message.id, (p) =>
      message.ok ? p.resolve(message.value) : p.reject(new ChannelError(message.error, message.code ?? null))
    );
  });

  function settle(id: number, finish: (p: Pending) => void): void {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    finish(waiting);
  }

  type Unsent<M> = M extends unknown ? Omit<M, "v" | "id"> : never;

  function request<T>(message: Unsent<BundleMessage>): { id: number; answer: Promise<T> } {
    const id = nextId++;
    if (closed) return { id, answer: Promise.reject(new ChannelError(CLOSED)) };
    const answer = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    port.post(encode({ v: CHANNEL_VERSION, id, ...message } as BundleMessage));
    return { id, answer };
  }

  function capabilities(): Promise<Capabilities> {
    asked ??= request<unknown>({ type: "capabilities" }).answer.then(
      (value) => readCapabilities(value) ?? coreCapabilities(),
      () => coreCapabilities()
    );
    return asked;
  }

  async function supports(type: MessageType): Promise<boolean> {
    return (await capabilities()).messages.includes(type);
  }

  /// For the two messages that are an ACT rather than a question: done
  /// or not done is all the caller can use.
  async function act(type: MessageType, message: Unsent<BundleMessage>): Promise<boolean> {
    if (!(await supports(type))) return false;
    return request(message).answer.then(
      () => true,
      () => false
    );
  }

  return {
    capabilities,
    supports,

    invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      return request<T>({ type: "invoke", cmd, args }).answer;
    },

    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      const { id, answer } = request<unknown>({ type: "listen", event });
      // Before the answer, not after: an event can overtake the
      // registration's own reply, and it was sent to this listener.
      listeners.set(id, handler as (payload: unknown) => void);
      try {
        await answer;
      } catch (e) {
        listeners.delete(id);
        throw e;
      }
      return () => {
        if (!listeners.delete(id)) return;
        if (closed) return;
        // Best-effort: the listener is already gone on this side, and an
        // end that never hears this only sends events nobody reads.
        request({ type: "unlisten", listener: id }).answer.catch(() => {});
      };
    },

    async openExternal(url: string): Promise<boolean> {
      if (!isWebLink(url)) return false;
      return act("open-external", { type: "open-external", url });
    },

    returnToHub(): Promise<boolean> {
      return act("return-to-hub", { type: "return-to-hub" });
    },

    onConnection(handler) {
      connectionHandlers.add(handler);
      return () => {
        connectionHandlers.delete(handler);
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      stopReceiving();
      listeners.clear();
      connectionHandlers.clear();
      const waiting = [...pending.values()];
      pending.clear();
      for (const p of waiting) p.reject(new ChannelError(CLOSED));
    },
  };
}
