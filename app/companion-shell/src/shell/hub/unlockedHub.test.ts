// The Unlock driving the live hub, against a scripted native Unlock and
// scripted Workstations: one prompt connects both, background drops both,
// a drop reconnects with no prompt, and a lapsed Unlock asks again
// without dropping what is open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { CoreExchange, CoreModule, ConnectEvent } from "$shell/core/core";
import { createUnlockedHub, type UnlockKeys } from "$shell/hub/unlockedHub";
import type { PairedWorkstation } from "$shell/hub/paired";
import type { LifecyclePhase } from "$shell/native/deviceKeys";
import { RelayLegError, type RelayMessage, type RelaySocket } from "$shell/pairing/relaySocket";
import { UNLOCK_REASON } from "$shell/unlock/unlock";

function record(n: number, name: string): PairedWorkstation {
  const key = `${n}${n}`.repeat(32);
  return {
    id: `ws-${key.slice(0, 16)}`,
    name,
    pairedAt: n,
    workstationKey: key,
    relays: [`ws://127.0.0.1:${8440 + n}`],
    relayAdmission: null,
    deviceId: `dev-${n}`,
    notificationKey: "5a".repeat(32),
  };
}
const STUDIO = record(1, "Studio");
const LAPTOP = record(2, "Laptop");

/// The native Unlock: `unlock` answers as told, `signUnlocked` signs only
/// while it is held, and `emit` plays the app's lifecycle.
function nativeUnlock() {
  let held = false;
  let answer: () => Promise<void> = async () => {};
  let listener: ((e: { phase: LifecyclePhase }) => void) | null = null;
  const sign = vi.fn(async () => {
    if (!held) throw Object.assign(new Error("no Unlock is held"), { code: "locked" });
    return { signature: "3045" };
  });
  const keys: UnlockKeys = {
    noiseKey: vi.fn(async () => ({ privateKey: "11".repeat(32) })),
    unlock: vi.fn(async () => {
      await answer();
      held = true;
      // A new authentication opens the hardware's window again.
      keys.signUnlocked = sign;
    }),
    signUnlocked: sign,
    lock: vi.fn(async () => {
      held = false;
    }),
    unlockState: vi.fn(async () => ({ unlocked: held, foreground: true })),
    addListener: vi.fn(async (_event: "lifecycle", fn: (e: { phase: LifecyclePhase }) => void) => {
      listener = fn;
      return { remove: async () => void (listener = null) };
    }),
  };
  return {
    keys,
    answerWith(next: () => Promise<void>) {
      answer = next;
    },
    emit(phase: LifecyclePhase) {
      // The native side ends it before it tells anyone.
      if (phase !== "foreground") held = false;
      listener?.({ phase });
    },
    sign,
    /// Android's auth window closing: still held, no longer signing.
    lapse() {
      keys.signUnlocked = vi.fn(async () => {
        throw Object.assign(new Error("user not authenticated"), { code: "unlock-expired" });
      });
    },
    /// A phone that will not sign even under a fresh authentication.
    broken() {
      const refuse = vi.fn(async () => {
        throw Object.assign(new Error("user not authenticated"), { code: "unlock-expired" });
      });
      keys.signUnlocked = refuse;
      keys.unlock = vi.fn(async () => {
        held = true;
        keys.signUnlocked = refuse;
      });
    },
  };
}

/// Two Workstations behind scripted Relays: each connection is a leg
/// that says ready, runs the handshake, says connected, then answers
/// every GetAttention with `items`.
function workstations() {
  const legs: Array<{ url: string; socket: RelaySocket; hangUp(): void }> = [];
  const attention: Record<string, string[]> = {};
  const open = vi.fn(async (url: string) => {
    let waiter: { resolve(m: RelayMessage): void; reject(e: Error): void } | null = null;
    const script: RelayMessage[] = [{ kind: "text", text: '{"type":"ready"}' }];
    let closed = false;
    const push = (m: RelayMessage) => {
      const w = waiter;
      waiter = null;
      if (w) w.resolve(m);
      else script.push(m);
    };
    const socket: RelaySocket = {
      next: () => {
        const m = script.shift();
        if (m) return Promise.resolve(m);
        if (closed) return Promise.reject(new RelayLegError("closed", "closed"));
        return new Promise((resolve, reject) => (waiter = { resolve, reject }));
      },
      send: (data) => {
        if (closed || typeof data === "string") return;
        // The core stand-in below writes one tagged byte per step.
        if (data[0] === 1) push({ kind: "bytes", bytes: new Uint8Array([2]) });
        if (data[0] === 0x30) push({ kind: "bytes", bytes: new Uint8Array([5]) });
        if (data[0] === 0x40) push({ kind: "bytes", bytes: new Uint8Array([7, ...new TextEncoder().encode(url)]) });
      },
      close: () => {
        closed = true;
        waiter?.reject(new RelayLegError("closed", "closed"));
      },
    };
    legs.push({
      url,
      socket,
      hangUp: () => {
        closed = true;
        waiter?.reject(new RelayLegError("closed", "closed"));
      },
    });
    return socket;
  });
  const exchange = (): CoreExchange => ({
    pairingStart: () => {
      throw new Error("no pairing here");
    },
    pairingReceive: () => [],
    pairingProve: () => [],
    connectStart: (o) => ({ send: new Uint8Array([1]), dials: o.relays.map((url) => ({ url, hello: "hello" })) }),
    connectReceive: (bytes): ConnectEvent[] => {
      if (bytes[0] === 2) return [{ type: "prove", handshakeHash: "ab".repeat(32) }];
      if (bytes[0] === 5) return [{ type: "connected", deviceId: "dev" }];
      const url = new TextDecoder().decode(bytes.subarray(1));
      const items = (attention[url] ?? []).map((id) => ({ id, workspace: "w", kind: "waiting", text: id, target: null }));
      return [{ type: "message", text: JSON.stringify({ type: "Attention", state: "ready", items, version: 1 }) }];
    },
    connectProve: () => [{ type: "send", bytes: new Uint8Array([0x30]) }],
    connectSend: () => new Uint8Array([0x40]),
    relayReply: () => ({ reply: "ready" }),
  });
  const core: CoreModule = { exchange: async () => exchange() };
  return {
    core,
    open,
    attention,
    live: () => legs.filter((l) => !(l.socket as unknown as { closed?: boolean }).closed),
    legsTo: (ws: PairedWorkstation) => legs.filter((l) => l.url === ws.relays[0]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

async function started() {
  const native = nativeUnlock();
  const w = workstations();
  w.attention[STUDIO.relays[0]] = ["studio-1"];
  w.attention[LAPTOP.relays[0]] = ["laptop-1", "laptop-2"];
  const hub = createUnlockedHub({
    keys: native.keys,
    core: async () => w.core,
    open: w.open,
    random: (n) => new Uint8Array(n),
    hub: { reconnect: { floorMs: 100, ceilingMs: 100, settledMs: 60_000 } },
  });
  hub.setPaired([STUDIO, LAPTOP]);
  await hub.start();
  await settle();
  return { native, w, hub };
}

describe("the Unlock driving the hub", () => {
  it("asks once at launch, and one authentication connects both Workstations", async () => {
    const { native, hub } = await started();
    expect(native.keys.unlock).toHaveBeenCalledTimes(1);
    expect(native.keys.unlock).toHaveBeenCalledWith({ reason: UNLOCK_REASON });
    expect(get(hub.unlock)).toMatchObject({ state: "unlocked" });
    expect(native.sign).toHaveBeenCalledTimes(2);
    const live = get(hub.live);
    expect(live[STUDIO.id]).toMatchObject({ state: "ready", items: [{ id: "studio-1" }] });
    expect(live[LAPTOP.id]).toMatchObject({ state: "ready", items: [{ id: "laptop-1" }, { id: "laptop-2" }] });
  });

  it("locks and drops both connections when the app goes to the background, and asks again on return", async () => {
    const { native, w, hub } = await started();
    native.emit("background");
    await settle();
    expect(get(hub.unlock)).toEqual({ state: "locked", why: "background" });
    expect(get(hub.live)).toEqual({ [STUDIO.id]: { state: "locked" }, [LAPTOP.id]: { state: "locked" } });
    expect(native.keys.lock).toHaveBeenCalled();
    for (const leg of w.legsTo(STUDIO).concat(w.legsTo(LAPTOP))) {
      await expect(leg.socket.next(1)).rejects.toThrow("closed");
    }

    native.emit("foreground");
    await settle();
    expect(native.keys.unlock).toHaveBeenCalledTimes(2);
    expect(get(hub.live)[STUDIO.id].state).toBe("ready");
  });

  it("locks when the phone locks", async () => {
    const { native, hub } = await started();
    native.emit("screen-locked");
    await settle();
    expect(get(hub.unlock)).toEqual({ state: "locked", why: "screen-locked" });
    expect(get(hub.live)[LAPTOP.id]).toEqual({ state: "locked" });
  });

  it("reconnects a dropped Workstation without asking the owner again", async () => {
    const { native, w, hub } = await started();
    w.legsTo(STUDIO)[0].hangUp();
    await settle();
    expect(get(hub.live)[STUDIO.id].state).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(100);
    expect(get(hub.live)[STUDIO.id].state).toBe("ready");
    expect(w.legsTo(STUDIO)).toHaveLength(2);
    expect(native.keys.unlock).toHaveBeenCalledTimes(1);
    expect(get(hub.live)[LAPTOP.id].state).toBe("ready");
  });

  it("stays locked when the owner dismisses the prompt, until they ask", async () => {
    const native = nativeUnlock();
    native.answerWith(async () => {
      throw Object.assign(new Error("the owner did not confirm"), { code: "cancelled" });
    });
    const w = workstations();
    const hub = createUnlockedHub({ keys: native.keys, core: async () => w.core, open: w.open, random: (n) => new Uint8Array(n) });
    hub.setPaired([STUDIO]);
    await hub.start();
    await settle();
    expect(get(hub.unlock)).toEqual({ state: "locked", why: "declined" });
    expect(w.open).not.toHaveBeenCalled();

    native.answerWith(async () => {});
    hub.requestUnlock();
    await settle();
    expect(get(hub.unlock)).toMatchObject({ state: "unlocked" });
    expect(get(hub.live)[STUDIO.id].state).toBe("ready");
  });

  it("asks again when the Unlock lapses, keeping the connection already open", async () => {
    const { native, w, hub } = await started();
    // An hour on, Android's window has closed, and a new connection is
    // needed: the Laptop drops.
    await vi.advanceTimersByTimeAsync(3_600_000);
    native.lapse();
    w.legsTo(LAPTOP)[w.legsTo(LAPTOP).length - 1].hangUp();
    await vi.advanceTimersByTimeAsync(100);
    expect(native.keys.unlock).toHaveBeenCalledTimes(2);
    await settle();
    expect(get(hub.unlock)).toMatchObject({ state: "unlocked" });
    expect(get(hub.live)[LAPTOP.id].state).toBe("ready");
    expect(w.legsTo(STUDIO)).toHaveLength(1);
    expect(get(hub.live)[STUDIO.id].state).toBe("ready");
  });

  it("locks rather than asking forever when the phone will not sign even after the owner confirmed", async () => {
    const { native, w, hub } = await started();
    await vi.advanceTimersByTimeAsync(3_600_000);
    native.broken();
    w.legsTo(LAPTOP)[w.legsTo(LAPTOP).length - 1].hangUp();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(native.keys.unlock).toHaveBeenCalledTimes(1);
    expect(get(hub.unlock)).toMatchObject({ state: "locked", why: "failed" });
    expect(get(hub.live)[STUDIO.id]).toEqual({ state: "locked" });
  });

  it("does not ask with nothing paired", async () => {
    const native = nativeUnlock();
    const w = workstations();
    const hub = createUnlockedHub({ keys: native.keys, core: async () => w.core, open: w.open, random: (n) => new Uint8Array(n) });
    hub.setPaired([]);
    await hub.start();
    await settle();
    expect(native.keys.unlock).not.toHaveBeenCalled();
  });
});
