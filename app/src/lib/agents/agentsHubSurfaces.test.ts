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
      expect(text).toContain("CustomsEditor");
    }
  });

  it("app tabs are Defaults | Customs | Complexity | Fallback | Pause", () => {
    const text = source(APP);
    expect(text).toContain("APP_AGENTS_TABS");
    expect(text).not.toContain("WORKSPACE_AGENTS_TABS");
    expect(source("agentsHub.ts")).toContain('label: "Defaults"');
    expect(source("agentsHub.ts")).toContain('label: "Customs"');
    expect(source("agentsHub.ts")).toContain('label: "Complexity"');
    expect(source("agentsHub.ts")).toContain('label: "Fallback"');
    expect(source("agentsHub.ts")).toContain('label: "Pause"');
  });

  it("workspace tabs are This agent | Customs | Complexity | Fallback | Pause", () => {
    const text = source(HUB);
    expect(text).toContain("WORKSPACE_AGENTS_TABS");
    expect(source("agentsHub.ts")).toContain('label: "This agent"');
  });

  it("Customs CRUD strings are present in the shared editor both views mount", () => {
    const editor = source("CustomsEditor.svelte");
    for (const s of ["Add custom", "Delete", "Command", "Model flag", "Effort flag", "API family"]) {
      expect(editor).toContain(s);
    }
    expect(source(HUB)).toContain("local");
    expect(source(HUB)).toContain("setWorkspaceCustomProfiles");
    expect(source(APP)).toContain("customProfiles: next");
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
