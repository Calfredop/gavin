import { describe, it, expect } from "vitest";
import { resolveIndex, hintDigitFor } from "$lib/shortcuts";

// The spec's central promise: a badge and the shortcut it advertises can
// never point at different items. Checked exhaustively rather than by
// example, because the 0/9 aliases make the off-by-one cases subtle.
describe("badge/routing agreement", () => {
  it("every badge digit routes back to the item that shows it", () => {
    for (let count = 0; count <= 12; count++) {
      for (let index = 0; index < count; index++) {
        const digit = hintDigitFor(index, count);
        if (digit === null) continue;
        expect(resolveIndex(digit, count), `count=${count} index=${index} digit=${digit}`).toBe(index);
      }
    }
  });

  it("an item without a badge is only ever reachable through the 0/9 aliases", () => {
    for (let count = 1; count <= 12; count++) {
      const badged = new Set<number>();
      for (let index = 0; index < count; index++) {
        if (hintDigitFor(index, count) !== null) badged.add(index);
      }
      for (let digit = 0; digit <= 9; digit++) {
        const index = resolveIndex(digit, count);
        if (index === null || badged.has(index)) continue;
        const isAliasOnly = index === 0 || index === count - 1;
        expect(isAliasOnly, `count=${count} index=${index} reachable but unbadged`).toBe(true);
      }
    }
  });

  it("no digit ever selects an item outside the list", () => {
    for (let count = 0; count <= 12; count++) {
      for (let digit = 0; digit <= 9; digit++) {
        const index = resolveIndex(digit, count);
        if (index === null) continue;
        expect(index, `count=${count} digit=${digit}`).toBeGreaterThanOrEqual(0);
        expect(index, `count=${count} digit=${digit}`).toBeLessThan(count);
      }
    }
  });
});
