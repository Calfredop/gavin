import { describe, expect, it } from "vitest";
import { RelayLegError, webSocketOpener, type WebSocketLike } from "$shell/pairing/relaySocket";

/// A WebSocket the test drives by hand.
class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  binaryType = "blob";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

const open = webSocketOpener(FakeSocket);

describe("a dial to a Workstation's own listener (ADR 0009)", () => {
  const PIN = "ab".repeat(32);

  it("is refused as unreachable, and opens nothing, when this build cannot trust a pin", async () => {
    const before = FakeSocket.last;
    await expect(open("wss://192.168.1.20:8445", 1000, PIN)).rejects.toMatchObject({ failure: "unreachable" });
    expect(FakeSocket.last).toBe(before);
  });

  it("has the platform trust the pinned certificate before the socket is opened", async () => {
    const asked: Array<[string, string, FakeSocket | undefined]> = [];
    const pinned = webSocketOpener(FakeSocket, async (url, pin) => {
      asked.push([url, pin, FakeSocket.last]);
    });
    const before = FakeSocket.last;
    const opening = pinned("wss://192.168.1.20:8445", 1000, PIN);
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual([["wss://192.168.1.20:8445", PIN, before]]);
    FakeSocket.last.onopen?.({});
    await opening;
    expect(FakeSocket.last.url).toBe("wss://192.168.1.20:8445");
  });

  it("opens nothing when the platform will not trust it", async () => {
    const pinned = webSocketOpener(FakeSocket, async () => {
      throw new Error("no such plugin");
    });
    const before = FakeSocket.last;
    await expect(pinned("wss://192.168.1.20:8445", 1000, PIN)).rejects.toMatchObject({ failure: "unreachable" });
    expect(FakeSocket.last).toBe(before);
  });

  it("asks nothing of the platform for a Relay", async () => {
    let asked = 0;
    const pinned = webSocketOpener(FakeSocket, async () => {
      asked++;
    });
    const opening = pinned("wss://relay.example", 1000, null);
    FakeSocket.last.onopen?.({});
    await opening;
    expect(asked).toBe(0);
  });
});

describe("a Device's leg to a Relay", () => {
  it("opens, reads text and binary frames in order, and asks for binary as bytes", async () => {
    const opening = open("ws://127.0.0.1:8443", 1000);
    const ws = FakeSocket.last;
    expect(ws.binaryType).toBe("arraybuffer");
    ws.onopen?.({});
    const leg = await opening;

    ws.onmessage?.({ data: '{"type":"ready"}' });
    ws.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    expect(await leg.next(100)).toEqual({ kind: "text", text: '{"type":"ready"}' });
    expect(await leg.next(100)).toEqual({ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) });

    const waiting = leg.next(1000);
    ws.onmessage?.({ data: new Uint8Array([9]).buffer });
    expect(await waiting).toEqual({ kind: "bytes", bytes: new Uint8Array([9]) });

    leg.send("hello");
    leg.send(new Uint8Array([4]));
    expect(ws.sent).toEqual(["hello", new Uint8Array([4])]);
  });

  it("calls a Relay that closes before opening unreachable", async () => {
    const opening = open("ws://127.0.0.1:1", 1000);
    FakeSocket.last.onclose?.({});
    await expect(opening).rejects.toMatchObject({ failure: "unreachable" });
  });

  it("gives up on a Relay that does not open in time", async () => {
    const opening = open("ws://10.0.0.9:8443", 10);
    await expect(opening).rejects.toMatchObject({ failure: "timeout" });
    expect(FakeSocket.last.closed).toBe(true);
  });

  it("ends every wait when the stream closes, and every wait after", async () => {
    const opening = open("ws://127.0.0.1:8443", 1000);
    const ws = FakeSocket.last;
    ws.onopen?.({});
    const leg = await opening;
    const waiting = leg.next(1000);
    ws.onclose?.({});
    await expect(waiting).rejects.toBeInstanceOf(RelayLegError);
    await expect(leg.next(1000)).rejects.toMatchObject({ failure: "closed" });
    leg.send("after");
    expect(ws.sent).toEqual([]);
  });

  it("times a wait out without ending the leg", async () => {
    const opening = open("ws://127.0.0.1:8443", 1000);
    const ws = FakeSocket.last;
    ws.onopen?.({});
    const leg = await opening;
    await expect(leg.next(5)).rejects.toMatchObject({ failure: "timeout" });
    ws.onmessage?.({ data: "late" });
    expect(await leg.next(100)).toEqual({ kind: "text", text: "late" });
  });
});
