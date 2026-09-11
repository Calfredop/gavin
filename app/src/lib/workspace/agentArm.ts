/// Setup-only arming for a fallback (or inherited default) agent.
///
/// Same Integration / Superpowers steps as workspace agent-change, but
/// MUST NOT commit a new active profile or rewrite difficulty pins. The
/// workspace agent stays where it is; these steps only make another CLI
/// launchable.

export type AgentArmStep = "integration" | "superpowers";

export const AGENT_ARM_STEPS: Array<{ id: AgentArmStep; label: string }> = [
  { id: "integration", label: "Integration" },
  { id: "superpowers", label: "Superpowers" },
];

export function nextAgentArmStep(step: AgentArmStep): AgentArmStep | null {
  const i = AGENT_ARM_STEPS.findIndex((s) => s.id === step);
  if (i < 0 || i >= AGENT_ARM_STEPS.length - 1) return null;
  return AGENT_ARM_STEPS[i + 1].id;
}
