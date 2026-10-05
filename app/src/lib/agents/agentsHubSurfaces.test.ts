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

  it("tabs are General plus one per agent", () => {
    expect(source("agentsHub.ts")).toContain('label: "General"');
    expect(source("agentsHub.ts")).toContain("agentsHubTabs");
    expect(source(APP)).toContain("Default agent");
    expect(source(HUB)).toContain("Local customs");
  });

  it("per-agent tabs carry customs CRUD and fallback", () => {
    expect(source(APP)).toContain("Add custom");
    expect(source(APP)).toContain("Delete");
    expect(source(HUB)).toContain("Add local custom");
    expect(source(HUB)).toContain("setWorkspaceCustomProfiles");
    expect(source(APP)).toContain("FallbackChainEditor");
    expect(source(HUB)).toContain("FallbackChainEditor");
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
