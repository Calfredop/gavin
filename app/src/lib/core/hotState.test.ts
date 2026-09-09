import { describe, it, expect, vi } from "vitest";
import { hotState } from "$lib/core/hotState";

describe("hotState", () => {
  it("builds a fresh value when there is no hot context", () => {
    // A production build and vitest both leave `import.meta.hot` undefined.
    // There is nothing to adopt in either, so every caller gets its own.
    const a = hotState("k", () => new Map<string, number>(), undefined);
    const b = hotState("k", () => new Map<string, number>(), undefined);
    expect(a).not.toBe(b);
  });

  it("hands a second module instance the value the first one built", () => {
    // The bag is the same object across a hot reload -- that is the whole
    // reason it can carry live state that the module itself cannot.
    const bag: Record<string, unknown> = {};
    const fresh = vi.fn(() => new Map<string, number>());

    const first = hotState("terminals", fresh, bag);
    first.set("s1", 1);
    const second = hotState("terminals", fresh, bag);

    expect(second).toBe(first);
    expect(second.get("s1")).toBe(1);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("keeps values under different keys apart", () => {
    const bag: Record<string, unknown> = {};
    const a = hotState("a", () => ({ n: 1 }), bag);
    const b = hotState("b", () => ({ n: 2 }), bag);
    expect(a).not.toBe(b);
    expect(hotState("a", () => ({ n: 3 }), bag)).toBe(a);
  });

  it("adopts a stored value even when it is falsy", () => {
    // `??=` would rebuild a 0 or an empty string every time. Nothing in the
    // app stores one today, but a helper that silently drops falsy state is
    // a trap for whoever reaches for it next.
    const bag: Record<string, unknown> = {};
    expect(hotState("n", () => 0, bag)).toBe(0);
    expect(hotState("n", () => 7, bag)).toBe(0);
  });
});
