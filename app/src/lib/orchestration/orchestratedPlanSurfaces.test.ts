import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The desk's three surfaces for an Orchestrated plan (v80), read from the
// committed source the way the other *Surfaces tests read theirs: the
// logic is orchestratedPlanView.ts's and tested there, and what no unit
// test can see is whether each template actually reaches for it -- and
// for the vocabulary it has to draw in.

const SOURCES = svelteSources();
const DETAIL = SOURCES["CardDetailModal.svelte"] ?? "";
const BOARD_CARD = SOURCES["BoardCard.svelte"] ?? "";
const STEP_CARD = SOURCES["OrchestrationStepCard.svelte"] ?? "";
const RAIL = SOURCES["OrchestrationRail.svelte"] ?? "";

describe("the Children control", () => {
  it("is offered through the view module and gated on a daemon that parses the line", () => {
    expect(DETAIL).toContain("childrenControlShown(card)");
    expect(DETAIL).toContain('featureBlockedReason($daemonCompat, "orchestratedPlans")');
    expect(DETAIL).toContain('writeField("children", childrenFieldValue(choice))');
    // The reason rides the row, which a disabled select cannot carry.
    expect(DETAIL).toContain('title={childrenBlocked ?? undefined}');
  });
});

describe("a nested task's row inside its plan's card", () => {
  it("draws its run state through the indicator vocabulary, worked out by its plan", () => {
    expect(BOARD_CARD).toContain("nestedTaskIndicator(nestedState)");
    expect(BOARD_CARD).toContain("nestedState={nestedChildState(card, slot.item, planRuns)}");
    expect(BOARD_CARD).toContain("<StatusBadge indicator={nestedTaskIndicator(nestedState)}");
  });

  it("marks the plan itself when it orchestrates its children", () => {
    expect(BOARD_CARD).toContain("childrenMarkTip(card.children)");
  });
});

describe("the rail step of an Orchestrated plan", () => {
  it("carries the n/m nested chip", () => {
    expect(RAIL).toContain("nested={nestedProgress(step, orch, cards)}");
    expect(STEP_CARD).toContain("nestedProgressText(nested)");
  });
});
