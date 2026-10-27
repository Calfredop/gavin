import { describe, it, expect } from "vitest";
import { isClipped } from "$lib/core/tooltip";

// The file rows' hover-for-the-whole-path keys off this: a row whose
// path fits shows no bubble at all.
describe("isClipped", () => {
  it("is true only when the content is wider than its box", () => {
    expect(isClipped({ scrollWidth: 300, clientWidth: 200 })).toBe(true);
    expect(isClipped({ scrollWidth: 200, clientWidth: 200 })).toBe(false);
    expect(isClipped({ scrollWidth: 120, clientWidth: 200 })).toBe(false);
  });
});
