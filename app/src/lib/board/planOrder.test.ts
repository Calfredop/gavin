import { describe, it, expect } from "vitest";
import { computeOrderWrites, ORDER_GAP } from "$lib/board/planOrder";

const c = (path: string, order: number | null) => ({ path, order });

describe("computeOrderWrites", () => {
  it("empty column: single write at ORDER_GAP", () => {
    expect(computeOrderWrites([], 0, "d")).toEqual([{ path: "d", order: ORDER_GAP }]);
  });

  it("append after an ordered tail: single write, +GAP", () => {
    expect(computeOrderWrites([c("a", 1024)], 1, "d")).toEqual([{ path: "d", order: 2048 }]);
  });

  it("insert at head before an ordered card: single write, -GAP", () => {
    expect(computeOrderWrites([c("a", 1024)], 0, "d")).toEqual([{ path: "d", order: 0 }]);
  });

  it("midpoint between ordered neighbors with room", () => {
    expect(computeOrderWrites([c("a", 1024), c("b", 2048)], 1, "d")).toEqual([
      { path: "d", order: 1536 },
    ]);
  });

  it("gap exhausted: renumbers the whole block in visual order", () => {
    expect(computeOrderWrites([c("a", 1024), c("b", 1025)], 1, "d")).toEqual([
      { path: "a", order: 1024 },
      { path: "d", order: 2048 },
      { path: "b", order: 3072 },
    ]);
  });

  it("unordered neighbor: materializes the block", () => {
    expect(computeOrderWrites([c("a", 1024), c("b", null)], 1, "d")).toEqual([
      { path: "a", order: 1024 },
      { path: "d", order: 2048 },
      { path: "b", order: 3072 },
    ]);
  });

  it("drop at end after an unordered card materializes too", () => {
    expect(computeOrderWrites([c("a", null)], 1, "d")).toEqual([
      { path: "a", order: 1024 },
      { path: "d", order: 2048 },
    ]);
  });

  it("clamps an out-of-range target index", () => {
    expect(computeOrderWrites([c("a", 1024)], 99, "d")).toEqual([{ path: "d", order: 2048 }]);
    expect(computeOrderWrites([c("a", 1024)], -1, "d")).toEqual([{ path: "d", order: 0 }]);
  });
});
