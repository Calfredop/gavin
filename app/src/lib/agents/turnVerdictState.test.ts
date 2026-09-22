import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("$lib/core/backend", () => ({
  typesafeSettings: vi.fn(),
}));

import * as backend from "$lib/core/backend";
import {
  PENDING_BACKSTOP_MS,
  __resetForTesting,
  loadTypesafeSettings,
  turnVerdictById,
  typesafeSettings,
  verdictsOf,
  whenTurnVerdictSettles,
} from "$lib/agents/turnVerdictState";
import { get } from "svelte/store";

const ASKING = { state: "read", reading: { kind: "asking" } } as const;

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadTypesafeSettings", () => {
  it("mirrors what the host reports, and nothing more", async () => {
    vi.mocked(backend.typesafeSettings).mockResolvedValue({ enabled: true, hasKey: true });
    await loadTypesafeSettings();
    expect(get(typesafeSettings)).toEqual({ enabled: true, hasKey: true });
  });

  it("leaves the setting unknown when the host cannot answer", async () => {
    // Unknown gates OFF in the driver, so an unreadable config is never
    // read as consent.
    vi.mocked(backend.typesafeSettings).mockRejectedValue(new Error("no config"));
    typesafeSettings.set({ enabled: true, hasKey: true });
    await loadTypesafeSettings();
    expect(get(typesafeSettings)).toBeNull();
  });
});

describe("verdictsOf", () => {
  it("is the same map the pure consumers take", () => {
    const map = verdictsOf({ s1: ASKING });
    expect(map.get("s1")).toEqual(ASKING);
    expect(map.has("s2")).toBe(false);
  });
});

describe("whenTurnVerdictSettles", () => {
  it("resolves at once for a session nobody asked about", async () => {
    await expect(whenTurnVerdictSettles("s1")).resolves.toBeUndefined();
  });

  it("resolves at once with an entry that has already settled", async () => {
    turnVerdictById.set({ s1: ASKING });
    await expect(whenTurnVerdictSettles("s1")).resolves.toEqual(ASKING);
  });

  it("waits for a pending entry, then hands over what it settled on", async () => {
    turnVerdictById.set({ s1: { state: "pending" } });
    let settled: unknown = "unsettled";
    const wait = whenTurnVerdictSettles("s1").then((e) => (settled = e));
    await Promise.resolve();
    expect(settled).toBe("unsettled");
    turnVerdictById.set({ s1: ASKING });
    await wait;
    expect(settled).toEqual(ASKING);
  });

  it("resolves with nothing when the entry is cleared instead", async () => {
    // A session that started talking again: the verdict it was waiting
    // on is about a turn that is over.
    turnVerdictById.set({ s1: { state: "pending" } });
    const wait = whenTurnVerdictSettles("s1");
    turnVerdictById.set({});
    await expect(wait).resolves.toBeUndefined();
  });

  it("gives up just after the driver's own backstop, so nothing can hang on it", async () => {
    vi.useFakeTimers();
    turnVerdictById.set({ s1: { state: "pending" } });
    let settled: unknown = "unsettled";
    void whenTurnVerdictSettles("s1").then((e) => (settled = e));
    await vi.advanceTimersByTimeAsync(PENDING_BACKSTOP_MS);
    expect(settled).toBe("unsettled");
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toEqual({ state: "pending" });
  });

  it("stops listening once it has answered", async () => {
    turnVerdictById.set({ s1: { state: "pending" } });
    const wait = whenTurnVerdictSettles("s1");
    turnVerdictById.set({ s1: ASKING });
    await expect(wait).resolves.toEqual(ASKING);
    // A later change must not reach a promise that has already resolved
    // -- which it cannot, but the subscription that would try has to be
    // gone, or every wait ever taken leaks a listener on this store.
    turnVerdictById.set({ s1: { state: "read", reading: null } });
    await expect(wait).resolves.toEqual(ASKING);
  });
});
