/// The workspace agent-change confirm flow: step order and the moment
/// config is written. Pure so the wizard template stays a thin shell.
///
/// Complexity is chosen first and nothing is written yet. Advancing from
/// that step commits the new profile and the realigned complexity table;
/// the remaining steps set up the NEW agent (MCP / skills via integration,
/// then Superpowers). Cancel before the commit leaves config untouched;
/// leaving later only skips leftover setup.

export type AgentChangeStep = "complexity" | "integration" | "superpowers";

export const AGENT_CHANGE_STEPS: Array<{ id: AgentChangeStep; label: string }> = [
  { id: "complexity", label: "Complexity" },
  { id: "integration", label: "Integration" },
  { id: "superpowers", label: "Superpowers" },
];

/// Whether advancing from this step writes the profile + complexity.
/// Only the complexity step is pre-commit; everything after assumes the
/// new profile is already in config.toml so setup_agent_integration and
/// Superpowers see the agent being switched to.
export function agentChangeCommitsOnAdvance(step: AgentChangeStep): boolean {
  return step === "complexity";
}

export function nextAgentChangeStep(step: AgentChangeStep): AgentChangeStep | null {
  const i = AGENT_CHANGE_STEPS.findIndex((s) => s.id === step);
  if (i < 0 || i >= AGENT_CHANGE_STEPS.length - 1) return null;
  return AGENT_CHANGE_STEPS[i + 1].id;
}
