import { describe, expect, it, vi } from "vitest";
import { holdTerminal } from "./terminalHolders";

// A session has ONE terminal and two places can want it at once: the page's
// own pane, and a hub section (Decisions, Review, ...) drawn as a navigator
// overlay OVER that page, which stays mounted underneath. The overlay's pane
// takes the container by appendChild; when it goes, the page's pane never
// remounts, so unless the container is handed back its tab is blank.
describe("holdTerminal", () => {
  it("hands the terminal back to the pane it was taken from", () => {
    const page = vi.fn();
    const overlay = vi.fn();
    holdTerminal("s1", page);
    const releaseOverlay = holdTerminal("s1", overlay);

    releaseOverlay();

    expect(page).toHaveBeenCalledTimes(1);
    expect(overlay).not.toHaveBeenCalled();
  });

  it("hands nothing back when the released pane was not showing it", () => {
    // Svelte builds the new branch before tearing the old one down, so
    // the pane that took the terminal last is routinely released AFTER
    // its successor mounted. The successor already has it.
    const old = vi.fn();
    const next = vi.fn();
    const releaseOld = holdTerminal("s2", old);
    holdTerminal("s2", next);

    releaseOld();

    expect(old).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("hands it to the most recent holder still mounted", () => {
    const page = vi.fn();
    const review = vi.fn();
    const decisions = vi.fn();
    holdTerminal("s3", page);
    const releaseReview = holdTerminal("s3", review);
    const releaseDecisions = holdTerminal("s3", decisions);

    releaseReview();
    expect(page).not.toHaveBeenCalled();
    releaseDecisions();

    expect(page).toHaveBeenCalledTimes(1);
    expect(review).not.toHaveBeenCalled();
  });

  it("keeps sessions apart, and a last release leaves nothing to hand to", () => {
    const a = vi.fn();
    const b = vi.fn();
    holdTerminal("s4", a);
    const releaseB = holdTerminal("s5", b);

    releaseB();

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("is idempotent: a second release hands nothing back twice", () => {
    const page = vi.fn();
    holdTerminal("s6", page);
    const release = holdTerminal("s6", vi.fn());

    release();
    release();

    expect(page).toHaveBeenCalledTimes(1);
  });
});
