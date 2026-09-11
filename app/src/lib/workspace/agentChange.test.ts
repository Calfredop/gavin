import { describe, expect, it } from "vitest";
import {
  AGENT_CHANGE_STEPS,
  agentChangeCommitsOnAdvance,
  agentChangeIsRerun,
  nextAgentChangeStep,
} from "$lib/workspace/agentChange";

describe("agentChange steps", () => {
  it("orders complexity before the setup steps that need the new profile", () => {
    expect(AGENT_CHANGE_STEPS.map((s) => s.id)).toEqual([
      "complexity",
      "integration",
      "superpowers",
    ]);
  });

  it("commits only when leaving the complexity step", () => {
    expect(agentChangeCommitsOnAdvance("complexity")).toBe(true);
    expect(agentChangeCommitsOnAdvance("integration")).toBe(false);
    expect(agentChangeCommitsOnAdvance("superpowers")).toBe(false);
  });

  it("advances through the list and ends after Superpowers", () => {
    expect(nextAgentChangeStep("complexity")).toBe("integration");
    expect(nextAgentChangeStep("integration")).toBe("superpowers");
    expect(nextAgentChangeStep("superpowers")).toBeNull();
  });

  it("treats the same profile as a re-run of setup, not a switch", () => {
    expect(agentChangeIsRerun("cursor", "cursor")).toBe(true);
    expect(agentChangeIsRerun("cursor", "claude-code")).toBe(false);
  });
});
