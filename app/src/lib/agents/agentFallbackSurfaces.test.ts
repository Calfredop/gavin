import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("fallback agent surfaces", () => {
  it("arms a named profile without switching the workspace agent", () => {
    const wizard = source("AgentArmWizard.svelte");
    expect(wizard).toContain("does not change the workspace's agent");
    expect(wizard).toContain("IntegrationStep");
    expect(wizard).toContain("SuperpowersStep");
    expect(wizard).not.toContain("switchWorkspaceAgentProfile");
    expect(wizard).not.toContain("setWorkspaceComplexityTable");
    expect(wizard).toMatch(/SuperpowersStep[\s\S]*\{profileId\}/);
    expect(source("agentArm.ts")).toContain("integration");
    expect(source("agentArm.ts")).not.toContain("complexity");
  });

  it("edits the chain in app settings, workspace settings, and the init wizard", () => {
    expect(source("GlobalSettingsView.svelte")).toContain("Fallback agent");
    expect(source("GlobalSettingsView.svelte")).toContain("FallbackChainEditor");
    expect(source("SettingsHubView.svelte")).toContain("Fallback agent");
    expect(source("SettingsHubView.svelte")).toContain("setWorkspaceFallback");
    expect(source("AgentStep.svelte")).toContain("FallbackChainEditor");
  });

  it("edits a per-profile walk-at percent on every chain surface", () => {
    expect(source("FallbackChainEditor.svelte")).toContain("onThresholdChange");
    expect(source("FallbackChainEditor.svelte")).toContain("fallbackThresholdFor");
    expect(source("SettingsHubView.svelte")).toContain("Walk at");
    expect(source("SettingsHubView.svelte")).toContain("fallbackThresholds");
    expect(source("AgentStep.svelte")).toContain("Walk at");
    expect(source("AgentStep.svelte")).toContain("fallbackThresholds");
    expect(source("GlobalSettingsView.svelte")).toContain("onThresholdChange");
    expect(source("GlobalSettingsView.svelte")).toContain("fallbackThresholds");
  });

  it("forces the arming wizard from a launch rather than skipping or launching degraded", () => {
    expect(source("cardRunActions.ts")).toContain("requestArm");
    expect(source("cardRunActions.ts")).toContain("holdLaunch");
    expect(source("orchestrationState.ts")).toContain("requestArm");
    expect(source("Sidebar.svelte")).toContain("AgentArmWizard");
  });

  it("tries the workspace agent before the configured chain", () => {
    expect(source("agentPauseState.ts")).toContain("workspaceProfileId");
    expect(source("agentFallback.ts")).toContain("workspaceProfileId");
    expect(source("agentFallback.ts")).not.toContain(
      "every agent in the fallback chain is at its usage limit"
    );
  });
});
