import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("init wizard agent PATH sweep", () => {
  it("probes binaries from the Agent step and shows them as found", () => {
    const step = source("AgentStep.svelte");
    expect(step).toContain("detectAgentBinaries");
    expect(step).toContain("foundAgentsSummary");
    expect(step).toContain("suggestMainProfile");
    expect(step).toContain("suggestFallbackChain");
    expect(step).toContain("missingFromAppFallback");
    expect(source("backend.ts")).toContain("detect_agent_binaries");
  });

  it("marks found and missing agents in the profile and fallback pickers", () => {
    expect(source("AgentStep.svelte")).toContain("(found)");
    expect(source("AgentStep.svelte")).toContain("foundIds");
    expect(source("FallbackChainEditor.svelte")).toContain("foundIds");
    expect(source("FallbackChainEditor.svelte")).toContain("sweptIds");
    expect(source("FallbackChainEditor.svelte")).toContain("(not found)");
  });

  it("reconciles suggestions against app fallback settings", () => {
    const logic = source("agentDetect.ts");
    expect(logic).toContain("appFallback");
    expect(logic).toContain("commandAlreadySet");
    expect(logic).toContain("missingFromAppFallback");
  });
});
