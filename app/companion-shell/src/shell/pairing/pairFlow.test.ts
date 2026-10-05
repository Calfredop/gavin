import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import type { KeptWorkstation } from "$shell/core/core";
import type { PairedStore, PairedWorkstation } from "$shell/hub/paired";
import { createPairFlow, spacedCode, type PairFlowDeps } from "$shell/pairing/pairFlow";
import type { PairingOutcome, PairingPhase } from "$shell/pairing/pairing";

const KEPT: KeptWorkstation = {
  workstationKey: "4a".repeat(32),
  relays: ["ws://127.0.0.1:8443"],
  relayAdmission: "let-me-in",
  deviceId: "dev-1",
  notificationKey: "5a".repeat(32),
};

function memoryStore(): PairedStore & { held: Map<string, PairedWorkstation> } {
  const held = new Map<string, PairedWorkstation>();
  return {
    held,
    list: async () => [...held.values()].sort((a, b) => a.pairedAt - b.pairedAt),
    save: async (record) => void held.set(record.id, record),
  };
}

function flow(overrides: Partial<PairFlowDeps> = {}) {
  const store = memoryStore();
  const lists: PairedWorkstation[][] = [];
  const lines: string[] = [];
  const deps: PairFlowDeps = {
    scan: async () => ({ text: "the-qr" }),
    pair: async (_qr, onPhase) => {
      onPhase({ phase: "connecting" });
      onPhase({ phase: "comparing", code: "123456" });
      return { outcome: "paired", workstation: KEPT };
    },
    store,
    now: () => 1000,
    onChange: (paired) => void lists.push(paired),
    log: (line) => void lines.push(line),
    ...overrides,
  };
  return { f: createPairFlow(deps), store, lists, lines };
}

describe("the hub's pairing flow", () => {
  it("scans, pairs, keeps the Workstation and lists it", async () => {
    const scanned: string[] = [];
    const { f, store, lists, lines } = flow({
      pair: async (qr, onPhase) => {
        scanned.push(qr);
        onPhase({ phase: "comparing", code: "123456" });
        return { outcome: "paired", workstation: KEPT };
      },
    });
    await f.start();
    expect(scanned).toEqual(["the-qr"]);
    const sheet = get(f.sheet);
    expect(sheet).toMatchObject({ step: "paired", workstation: { name: "Workstation", deviceId: "dev-1" } });
    expect([...store.held.values()]).toHaveLength(1);
    expect(lists).toEqual([[...store.held.values()]]);
    expect(lines).toEqual(["[gavin-pair] code 123456", "[gavin-pair] paired ws-4a4a4a4a4a4a4a4a as dev-1"]);
  });

  it("shows each phase while the pairing runs", async () => {
    const seen: PairingPhase[] = [];
    let release!: (o: PairingOutcome) => void;
    const { f } = flow({
      pair: (_qr, onPhase) => {
        onPhase({ phase: "confirming" });
        return new Promise((resolve) => (release = resolve));
      },
    });
    const unsubscribe = f.sheet.subscribe((s) => {
      if (s.step === "working") seen.push(s.phase);
    });
    const running = f.startWith("qr");
    expect(get(f.sheet)).toEqual({ step: "working", phase: { phase: "confirming" } });
    release({ outcome: "failed", problem: "The desk declined this pairing. Nothing was paired." });
    await running;
    unsubscribe();
    expect(seen).toEqual([{ phase: "confirming" }]);
    expect(get(f.sheet)).toEqual({ step: "failed", problem: "The desk declined this pairing. Nothing was paired." });
  });

  it("closes quietly when the owner closes the scanner, and says why a scan could not happen", async () => {
    const closed = flow({ scan: () => Promise.reject(Object.assign(new Error("closed"), { code: "cancelled" })) });
    await closed.f.start();
    expect(get(closed.f.sheet)).toEqual({ step: "closed" });

    const denied = flow({ scan: () => Promise.reject(Object.assign(new Error("denied"), { code: "camera-denied" })) });
    await denied.f.start();
    expect(get(denied.f.sheet)).toEqual({
      step: "failed",
      problem: "Gavin may not use the camera. Allow it in Settings, then scan again.",
    });
  });

  it("cancels the pairing that is running, and ignores what it says after", async () => {
    let signal!: AbortSignal;
    let release!: (o: PairingOutcome) => void;
    const { f, store } = flow({
      pair: (_qr, onPhase, s) => {
        signal = s;
        onPhase({ phase: "comparing", code: "123456" });
        return new Promise((resolve) => (release = resolve));
      },
    });
    const running = f.startWith("qr");
    f.cancel();
    expect(signal.aborted).toBe(true);
    expect(get(f.sheet)).toEqual({ step: "closed" });
    // A pairing that finished anyway, as the cancel crossed its verdict.
    release({ outcome: "paired", workstation: KEPT });
    await running;
    expect(get(f.sheet)).toEqual({ step: "closed" });
    expect(store.held.size).toBe(0);
  });

  it("names the Workstation just paired, and keeps the name", async () => {
    const { f, store, lists } = flow();
    await f.startWith("qr");
    await f.rename("  Studio Mac  ");
    expect(get(f.sheet)).toMatchObject({ step: "paired", workstation: { name: "Studio Mac" } });
    expect([...store.held.values()][0].name).toBe("Studio Mac");
    expect(lists.at(-1)?.[0].name).toBe("Studio Mac");
  });

  it("says so when the phone could not keep what the desk paired", async () => {
    const { f } = flow({
      store: { list: async () => [], save: vi.fn(async () => Promise.reject(new Error("keychain full"))) },
    });
    await f.startWith("qr");
    expect(get(f.sheet)).toMatchObject({ step: "failed", problem: expect.stringContaining("keychain full") });
  });
});

describe("the six digits on the phone", () => {
  it("reads as two groups of three", () => {
    expect(spacedCode("042917")).toBe("042 917");
    expect(spacedCode("04291")).toBe("04291");
  });
});
