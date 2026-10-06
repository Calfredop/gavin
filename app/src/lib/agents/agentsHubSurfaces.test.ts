import { describe, expect, it } from "vitest";
import { source } from "$lib/sources";

const APP = "GlobalSettingsView.svelte";
const HUB = "SettingsHubView.svelte";

describe("Desktop Agents hub surfaces", () => {
  it("both panels ship one agents section with the shared tab shell", () => {
    for (const file of [APP, HUB]) {
      const text = source(file);
      expect(text).toContain('hidden={!settingsFilter.visible("agents")');
      expect(text).toContain("<h3>Agents</h3>");
      expect(text).toContain("AGENTS_SECTION");
      expect(text).toContain("AgentsHubTabs");
      expect(text).toContain("agentsHubTabs");
      expect(text).toContain("GENERAL_TAB");
    }
  });

  it("tabs are General plus one per agent, then a trailing + that adds a custom", () => {
    expect(source("agentsHub.ts")).toContain('label: "General"');
    expect(source("agentsHub.ts")).toContain("agentsHubTabs");
    expect(source("agentsHub.ts")).toContain('export const ADD_TAB');
    expect(source(APP)).toContain("Default agent");
    // Both pages hand the strip the add hint, which is the "+" tab's tooltip.
    expect(source(APP)).toContain("agentsHubTabs(allProfiles, ADD_TAB_HINT.app)");
    expect(source(HUB)).toContain("agentsHubTabs(profiles, ADD_TAB_HINT.workspace)");
    // The strip draws that hint with the app's own tooltip action.
    expect(source("AgentsHubTabs.svelte")).toContain("use:tooltip");
    expect(source("AgentsHubTabs.svelte")).toContain("ADD_TAB");
  });

  it("the add-a-custom form lives on the + tab, not under General", () => {
    for (const [file, button] of [
      [APP, "Add custom"],
      [HUB, "Add local custom"],
    ] as const) {
      const text = source(file);
      const general = text.slice(
        text.indexOf("{#if agentsTab === GENERAL_TAB}"),
        text.indexOf("{:else if agentsTab ===")
      );
      expect(general).not.toContain(button);
      expect(text).toContain("{:else if agentsTab === ADD_TAB}");
      expect(text.slice(text.indexOf("{:else if agentsTab === ADD_TAB}"))).toContain(button);
    }
    // The hint text left the page: it is the tooltip now.
    expect(source(APP)).not.toContain("Each custom gets its own tab for command");
    expect(source(HUB)).not.toContain("Locals are marked on their tabs and only exist");
  });

  it("per-agent tabs carry customs CRUD and the same per-agent panel General shows", () => {
    expect(source(APP)).toContain("Delete");
    expect(source(HUB)).toContain("setWorkspaceCustomProfiles");
    expect(source(HUB)).toContain("dropWorkspaceProfileRefs");
    for (const [file, firstAgentTab] of [
      [APP, "{:else if activeAgentProfile}"],
      [HUB, "{:else if agentsTab === agent.profileId}"],
    ] as const) {
      const text = source(file);
      // General: the selected agent; a tab: its own.
      const start = text.indexOf("{#if agentsTab === GENERAL_TAB}");
      const general = text.slice(start, text.indexOf(firstAgentTab, start));
      expect(general).toContain("<AgentPrimaryPanel");
      // ...and at least once more for the agent tabs.
      expect(text.match(/<AgentPrimaryPanel/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      // Nothing per-agent is drawn twice: the editors live in the panel.
      expect(text).not.toContain("<FallbackChainEditor");
      expect(text).not.toContain("<ComplexityTable");
    }
    const panel = source("AgentPrimaryPanel.svelte");
    expect(panel).toContain("<FallbackChainEditor");
    expect(panel).toContain("<ComplexityTable");
    expect(panel).toContain("<PromptParamsEditor");
  });

  it("leaves Headroom, Tools and TypeSafe as their own top-level sections on the app page", () => {
    const text = source(APP);
    expect(text).toContain('visible("headroom")');
    expect(text).toContain('visible("tools")');
    expect(text).toContain('visible("typesafe")');
    expect(text).not.toContain('visible("agent-defaults")');
    expect(text).not.toContain('visible("custom-agent")');
    expect(text).not.toContain('visible("fallback-agent")');
    expect(text).not.toContain('visible("agent-pause")');
  });

  it("workspace Headroom is its own top-level section, not inside Agents", () => {
    const text = source(HUB);
    expect(text).toContain('visible("headroom")');
    expect(text).toContain("<h3>Headroom</h3>");
    expect(text).not.toContain('visible("agent")');
    expect(text).not.toContain('visible("complexity") || selectedSection !== "complexity"');
  });
});
