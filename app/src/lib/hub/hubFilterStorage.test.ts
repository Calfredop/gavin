import { describe, it, expect } from "vitest";
import { get, writable } from "svelte/store";
import { isStringArray, loadRecord, mirrorRecord } from "$lib/hub/hubFilterStorage";

function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}
const revive = (v: unknown) => (isStringArray(v) ? v : null);

describe("hub filter storage", () => {
  it("round-trips a record and drops default entries", () => {
    const storage = memory();
    const store = writable<Record<string, string[]>>({});
    mirrorRecord(store, "k", (v) => (v.length ? v : null), storage);
    store.set({ a: ["x"], b: [] });
    expect(loadRecord("k", revive, storage)).toEqual({ a: ["x"] });
    store.set({});
    expect(storage.m.has("k")).toBe(false);
    expect(get(store)).toEqual({});
  });

  it("forgets corrupt, mistyped or missing storage", () => {
    expect(loadRecord("k", revive, memory({ k: "{nope" }))).toEqual({});
    expect(loadRecord("k", revive, memory({ k: "[1]" }))).toEqual({});
    expect(loadRecord("k", revive, memory({ k: '{"a":[1],"b":["y"]}' }))).toEqual({ b: ["y"] });
    expect(loadRecord("k", revive, undefined)).toEqual({});
  });
});
