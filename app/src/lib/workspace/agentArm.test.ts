import { describe, expect, it } from "vitest";
import { AGENT_ARM_STEPS, nextAgentArmStep } from "$lib/workspace/agentArm";

describe("agent arming steps", () => {
  it("is Integration then agent skills, with no complexity and no profile commit", () => {
    expect(AGENT_ARM_STEPS.map((s) => s.id)).toEqual(["integration", "agentSkills"]);
    expect(nextAgentArmStep("integration")).toBe("agentSkills");
    expect(nextAgentArmStep("agentSkills")).toBeNull();
  });
});
