import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIST_SHARE,
  LIST_SHARE_KEY,
  listShareFromWidth,
  loadListShare,
  MIN_SIDE_PX,
  saveListShare,
} from "$lib/cards/runChangesSplit";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe("listShareFromWidth", () => {
  it("turns a dragged width into the list's share of the pair", () => {
    expect(listShareFromWidth(250, 1000)).toBe(0.25);
  });

  it("keeps both the list and the diff at least MIN_SIDE_PX wide", () => {
    expect(listShareFromWidth(0, 1000)).toBe(MIN_SIDE_PX / 1000);
    expect(listShareFromWidth(5000, 1000)).toBe((1000 - MIN_SIDE_PX) / 1000);
  });

  // offsetWidth is 0 while the pane is hidden; a pane too narrow for two
  // minimums keeps the default rather than clipping one side away.
  it("falls back to the default when there is no width to divide", () => {
    expect(listShareFromWidth(100, 0)).toBe(DEFAULT_LIST_SHARE);
    expect(listShareFromWidth(100, MIN_SIDE_PX * 2)).toBe(DEFAULT_LIST_SHARE);
  });
});

describe("loadListShare / saveListShare", () => {
  it("round-trips a dragged share", () => {
    const s = memoryStorage();
    saveListShare(0.4, s);
    expect(loadListShare(s)).toBe(0.4);
  });

  it("forgets the share on null, so the view reopens at the default", () => {
    const s = memoryStorage({ [LIST_SHARE_KEY]: "0.4" });
    saveListShare(null, s);
    expect(s.map.has(LIST_SHARE_KEY)).toBe(false);
    expect(loadListShare(s)).toBe(DEFAULT_LIST_SHARE);
  });

  it("reads anything that is not a share as the default", () => {
    for (const raw of ["", "abc", "0", "1", "-0.2", "7"]) {
      expect(loadListShare(memoryStorage({ [LIST_SHARE_KEY]: raw }))).toBe(DEFAULT_LIST_SHARE);
    }
  });

  it("survives a storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadListShare(hostile)).toBe(DEFAULT_LIST_SHARE);
    expect(() => saveListShare(0.3, hostile)).not.toThrow();
  });
});
