// A Device's leg to a Relay: the webview's own WebSocket.
//
// The Relay's contract (`protocol::relay`) is one text frame each way to
// be matched up -- the Device's hello, the Relay's reply -- and then
// binary frames the Relay copies to the Workstation and back. The core
// writes the hello and reads the reply; this only carries frames, and
// turns the socket's callbacks into something a pairing can wait on.
//
// A webview's WebSocket cannot set a header, which is why the admission
// token rides in the hello and not in a header (`protocol::relay`'s docs).

export type RelayMessage = { kind: "text"; text: string } | { kind: "bytes"; bytes: Uint8Array };

export type RelayLegFailure = "unreachable" | "closed" | "timeout";

export class RelayLegError extends Error {
  constructor(
    readonly failure: RelayLegFailure,
    message: string
  ) {
    super(message);
    this.name = "RelayLegError";
  }
}

export interface RelaySocket {
  /// The next frame, within `timeoutMs`. Rejects with `RelayLegError`
  /// once the socket has closed, and on a timeout.
  next(timeoutMs: number): Promise<RelayMessage>;
  send(data: string | Uint8Array): void;
  close(): void;
}

/// Opens a socket to `url`, resolving once it is open. `pin`, for a
/// Workstation's direct listener (ADR 0009), is the SHA-256 (hex) of the
/// one certificate to trust there; null or absent for a Relay.
export type OpenRelaySocket = (url: string, timeoutMs: number, pin?: string | null) => Promise<RelaySocket>;

/// How long a Workstation's direct address (ADR 0009) has to open and say
/// `ready`. Short, because it was written down at pairing: a LAN address
/// the Mac has since given up, or a network the phone has left, answers
/// nothing, and every second spent on it is a second before the Relay is
/// tried. A listener that is there answers at once -- it matches nothing.
export const DIRECT_DIAL_MS = 4_000;

/// How long a dial may take, given the caller's budget for a Relay.
export function dialTimeout(pin: string | null | undefined, relayMs: number): number {
  return pin ? Math.min(relayMs, DIRECT_DIAL_MS) : relayMs;
}

/// Has the platform accept `pin`'s certificate -- and only it -- at
/// `url`'s host and port, for the socket about to be opened. The webview's
/// own WebSocket cannot be told which certificate to trust and refuses a
/// self-signed one; the shell's native side can be. Rejects when it
/// cannot, and then nothing is dialled.
export type TrustPinned = (url: string, pin: string) => Promise<void>;

/// What the shell needs of a WebSocket: the browser's, or Node's for the
/// scripted pairing.
export interface WebSocketLike {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/// The opener over `Socket`. A dial that carries a pin goes through
/// `trustPinned` first; with none given, it is refused as unreachable, and
/// the caller moves on to the next dial -- the Relay.
export function webSocketOpener(Socket: WebSocketConstructor, trustPinned?: TrustPinned): OpenRelaySocket {
  const opening = openSocket(Socket);
  return async (url, timeoutMs, pin) => {
    if (pin) {
      if (!trustPinned) {
        throw new RelayLegError("unreachable", `this Companion cannot yet trust the Workstation's own certificate at ${url}`);
      }
      try {
        await trustPinned(url, pin);
      } catch (e) {
        throw new RelayLegError("unreachable", `could not trust the Workstation's certificate at ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return opening(url, timeoutMs);
  };
}

function openSocket(Socket: WebSocketConstructor): (url: string, timeoutMs: number) => Promise<RelaySocket> {
  return (url, timeoutMs) =>
    new Promise((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = new Socket(url);
      } catch (e) {
        reject(new RelayLegError("unreachable", `could not open ${url}: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      ws.binaryType = "arraybuffer";
      const leg = new Leg(ws);
      let opened = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new RelayLegError("timeout", `the Relay at ${url} did not answer in time`));
      }, timeoutMs);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve(leg);
      };
      ws.onerror = ws.onclose = () => {
        leg.end();
        // Before `open`, a close is a Relay that was never reached.
        if (!opened) {
          clearTimeout(timer);
          reject(new RelayLegError("unreachable", `could not reach the Relay at ${url}`));
        }
      };
      ws.onmessage = (event) => leg.arrived(event.data);
    });
}

class Leg implements RelaySocket {
  private queue: RelayMessage[] = [];
  private waiting: Array<{ resolve(m: RelayMessage): void; reject(e: Error): void }> = [];
  private ended = false;

  constructor(private ws: WebSocketLike) {}

  arrived(data: unknown): void {
    let message: RelayMessage;
    if (typeof data === "string") message = { kind: "text", text: data };
    else if (data instanceof ArrayBuffer) message = { kind: "bytes", bytes: new Uint8Array(data) };
    else if (ArrayBuffer.isView(data)) message = { kind: "bytes", bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() };
    else return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(message);
    else this.queue.push(message);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(closed());
  }

  next(timeoutMs: number): Promise<RelayMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.ended) return Promise.reject(closed());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (m: RelayMessage) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        reject(new RelayLegError("timeout", "the Workstation did not answer in time"));
      }, timeoutMs);
      this.waiting.push(waiter);
    });
  }

  send(data: string | Uint8Array): void {
    if (!this.ended) this.ws.send(data);
  }

  close(): void {
    this.end();
    this.ws.close();
  }
}

function closed(): RelayLegError {
  return new RelayLegError("closed", "the stream to the Workstation closed");
}
