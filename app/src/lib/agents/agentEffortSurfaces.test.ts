import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

// Agent effort is one setting drawn on six surfaces -- the app-wide
// defaults, the custom agent's flag, both complexity tables, a
// workspace's Agent section and a card's controls -- plus the resolution
// every launcher shares. Nothing links those files, so a picker wired to
// no setter, or a compat gate nothing reads, type-checks and renders
// perfectly. This pins the wiring the way cardAgentSurfaces.test.ts does:
// by reading the sources, not the DOM.

const SOURCES = { ...svelteSources(), ...tsSources() };

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the agentEffort gate", () => {
  it("is v56, the version that parses and writes the daemon-side effort", () => {
    expect(FEATURE_MIN_VERSION.agentEffort).toBe(56);
  });

  // An entry with no consumer is a dead gate (CLAUDE.md): each surface
  // that can produce a daemon-side effort payload reads it.
  it.each(["SettingsHubView.svelte", "CardDetailModal.svelte", "PlanMetadataPanel.svelte"])(
    "%s reads it",
    (file) => {
      expect(source(file)).toContain('featureBlockedReason($daemonCompat, "agentEffort")');
    }
  );

  it("reaches the card's shared controls from both card surfaces", () => {
    expect(source("CardDetailModal.svelte")).toContain("effortBlocked={cardEffortBlocked}");
    expect(source("PlanMetadataPanel.svelte")).toContain("effortBlocked={cardEffortBlocked}");
    expect(source("CardAgentControls.svelte")).toContain('onChange("effort", value)');
  });
});

describe("the settings surfaces", () => {
  it("offers the app-wide default per profile and saves it through setAgentDefaults", () => {
    const view = source("GlobalSettingsView.svelte");
    expect(view).toContain("effortOptions(");
    expect(view).toContain("setAgentDefaults(withAgentEffort($agentDefaultsStore, profileId, value))");
    // A named custom's own effort flag is edited on its per-agent tab.
    expect(view).toContain("patchActiveCustom({ effortFlag:");
  });

  it("writes the workspace's own effort and flag to config.toml", () => {
    const view = source("SettingsHubView.svelte");
    expect(view).toContain('setAgentField(workspaceId, "effort", value)');
    expect(view).toContain('setAgentField(workspaceId, "effort_flag", commit.value)');
  });

  it("gives every complexity row an effort box", () => {
    expect(source("ComplexityTable.svelte")).toContain("typeEffort(level, e.currentTarget.value)");
  });
});

describe("resolution", () => {
  // Every one-shot and reactive resolution in layoutState hands the
  // app-wide efforts in: a path that forgot would launch at the agent's
  // default with the setting still showing in the panel. `defaultAgent`
  // trails `agentEfforts` in the argument list, so a call ending in it
  // passed both.
  it("passes the app-wide efforts to every resolveAgentConfig in layoutState", () => {
    const layout = source("layoutState.ts");
    const calls = layout.split("resolveAgentConfig(").length - 1;
    const withEfforts = (layout.match(/\.defaultAgent\n\s*\)/g) ?? []).length;
    expect(calls).toBeGreaterThan(0);
    expect(withEfforts).toBe(calls);
  });

  it("launches a worktree's agent from the shared reactive resolution", () => {
    expect(source("GitWorktreeSwitcher.svelte")).toContain("$resolvedAgents(workspaceId)");
  });
});
