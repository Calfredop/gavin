import { describe, expect, it } from "vitest";
import { endsTurn } from "$lib/core/turnEnd";

describe("endsTurn", () => {
  it("is idle and its two refinements", () => {
    expect(endsTurn("idle")).toBe(true);
    expect(endsTurn("background")).toBe(true);
    expect(endsTurn("done")).toBe(true);
  });

  it("is nothing else -- above all not an absent or unknown status", () => {
    for (const status of ["working", "waiting_for_input", "failed", "unknown", "exited", undefined, null]) {
      expect(endsTurn(status)).toBe(false);
    }
  });
});
