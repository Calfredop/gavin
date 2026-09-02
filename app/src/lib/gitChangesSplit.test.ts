import { describe, it, expect } from "vitest";
import { DEFAULT_SHARE, MIN_LIST_PX, shareFromHeight } from "./gitChangesSplit";

describe("shareFromHeight", () => {
  it("turns a dragged height into that block's share of the pair", () => {
    expect(shareFromHeight(150, 600)).toBe(0.25);
    expect(shareFromHeight(300, 600)).toBe(DEFAULT_SHARE);
  });

  it("keeps the block below the divider from being swallowed", () => {
    // (600 - 56) / 600, rounded: the block below keeps MIN_LIST_PX.
    expect(shareFromHeight(600, 600)).toBe(0.9067);
    expect(shareFromHeight(1000, 600)).toBe(0.9067);
  });

  it("keeps the block above the divider visible", () => {
    // 56 / 600, rounded.
    expect(shareFromHeight(0, 600)).toBe(0.0933);
    expect(shareFromHeight(-200, 600)).toBe(0.0933);
  });

  // A short pane cannot honour both minimums; halving beats pinning one
  // block open and clipping the other away entirely.
  it("splits evenly when there is no room for two minimums", () => {
    expect(shareFromHeight(10, 80)).toBe(DEFAULT_SHARE);
    expect(shareFromHeight(70, MIN_LIST_PX * 2)).toBe(DEFAULT_SHARE);
  });

  // offsetHeight is 0 while the pane is hidden or still laying out.
  it("falls back to an even split when the pane has no height to divide", () => {
    expect(shareFromHeight(120, 0)).toBe(DEFAULT_SHARE);
    expect(shareFromHeight(120, -10)).toBe(DEFAULT_SHARE);
  });

  it("rounds to four decimals so the stored value round-trips through JSON", () => {
    expect(shareFromHeight(200, 601)).toBe(0.3328);
  });

  it("accepts a caller-supplied minimum", () => {
    expect(shareFromHeight(10, 600, 120)).toBe(0.2);
  });
});
