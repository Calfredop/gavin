import { describe, it, expect } from "vitest";
import {
  SMOKE_SECTIONS,
  loadChecked,
  saveChecked,
  storageKey,
  totalItems,
} from "./smokeChecklist";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("smokeChecklist data", () => {
  it("has unique item ids across every section", () => {
    const ids = SMOKE_SECTIONS.flatMap((s) => s.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(totalItems()).toBe(ids.length);
  });
});

describe("checklist persistence", () => {
  it("round-trips checked ids per workspace", () => {
    const storage = fakeStorage();
    saveChecked("ws-1", new Set(["seed", "plan-drag"]), storage);
    expect(loadChecked("ws-1", storage)).toEqual(new Set(["seed", "plan-drag"]));
    // A different workspace keeps its own progress.
    expect(loadChecked("ws-2", storage)).toEqual(new Set());
    expect(Object.keys(storage.data)).toEqual([storageKey("ws-1")]);
  });

  it("treats absent, corrupt, and wrong-shaped payloads as nothing checked", () => {
    expect(loadChecked("ws-1", fakeStorage())).toEqual(new Set());
    expect(loadChecked("ws-1", fakeStorage({ [storageKey("ws-1")]: "{not json" }))).toEqual(new Set());
    expect(loadChecked("ws-1", fakeStorage({ [storageKey("ws-1")]: '{"a":1}' }))).toEqual(new Set());
    expect(loadChecked("ws-1", fakeStorage({ [storageKey("ws-1")]: "[1,2,\"seed\"]" }))).toEqual(
      new Set(["seed"])
    );
  });

  it("is a no-op without storage instead of throwing", () => {
    expect(() => saveChecked("ws-1", new Set(["seed"]), undefined)).not.toThrow();
    expect(loadChecked("ws-1", undefined)).toEqual(new Set());
  });
});
