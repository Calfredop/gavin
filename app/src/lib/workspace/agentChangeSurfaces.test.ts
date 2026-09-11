import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

// Switching the workspace Profile used to call setAgentField immediately,
// which left complexity pins pointing at the previous agent with no
// chance to realign and no MCP/Superpowers/skills check for the new CLI.
// The confirm mini-wizard is the whole fix; these pins catch a regression
// that rewires the select back to a direct write.

const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const SETTINGS = "SettingsHubView.svelte";
const WIZARD = "AgentChangeWizard.svelte";
const HELPERS = "complexity.ts";
const STEPS = "agentChange.ts";

describe("workspace agent change", () => {
  it("opens the confirm wizard from the Profile select instead of writing immediately", () => {
    const text = source(SETTINGS);
    expect(text).toContain("AgentChangeWizard");
    expect(text).toContain("pendingProfileChange");
    // The select must not call setAgentField for profile on change — that
    // is the bug this plan closes.
    expect(text).not.toMatch(
      /onchange=\{[^}]*setAgentField\(workspaceId,\s*"profile"/
    );
  });

  it("offers a re-run of the wizard for the agent already selected", () => {
    const text = source(SETTINGS);
    expect(text).toMatch(/Set up .* again/);
    expect(text).toContain("pendingProfileChange = agent.profileId");
  });

  it("realigns complexity and applies the new profile's command on a switch", () => {
    const wizard = source(WIZARD);
    expect(wizard).toContain("realignComplexityTable");
    expect(wizard).toContain("recommendedComplexityAction");
    expect(wizard).toContain("IntegrationStep");
    expect(wizard).toContain("SuperpowersStep");
    expect(wizard).toContain("switchWorkspaceAgentProfile");
    expect(wizard).toContain("agentChangeIsRerun");

    expect(source(HELPERS)).toContain("export function realignComplexityTable");
    expect(source(STEPS)).toContain('id: "complexity"');
    expect(source(STEPS)).toContain("agentChangeIsRerun");
  });
});
