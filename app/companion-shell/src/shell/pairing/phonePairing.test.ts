import { describe, expect, it, vi } from "vitest";
import { coreOnce } from "$shell/pairing/phonePairing";
import { coreWasm } from "$shell/testing/coreWasm";

const bytes = (): ArrayBuffer => coreWasm().buffer as ArrayBuffer;

describe("loading the core for a pairing", () => {
  it("compiles it once and keeps it", async () => {
    const fetchBytes = vi.fn(async () => bytes());
    const core = coreOnce(fetchBytes);
    const first = await core();
    expect(await core()).toBe(first);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("tries again after a load that failed", async () => {
    const fetchBytes = vi
      .fn<[], Promise<ArrayBuffer>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => bytes());
    const core = coreOnce(fetchBytes);
    await expect(core()).rejects.toThrow("offline");
    await expect(core()).resolves.toBeDefined();
    expect(fetchBytes).toHaveBeenCalledTimes(2);
  });
});
