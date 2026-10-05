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

/// Opens a socket to `url`, resolving once it is open.
export type OpenRelaySocket = (url: string, timeoutMs: number) => Promise<RelaySocket>;

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

export function webSocketOpener(Socket: WebSocketConstructor): OpenRelaySocket {
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
