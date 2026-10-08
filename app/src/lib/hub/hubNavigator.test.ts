import { describe, it, expect } from "vitest";
import { hubNavigatorLabel, hubNavigatorViewIds } from "$lib/hub/hubNavigator";
import { tabStripHubViewIds } from "$lib/hub/hubViewMeta";

describe("hubNavigatorViewIds", () => {
  it("is the strip's list with Settings after it", () => {
    const ids = hubNavigatorViewIds(true);
    expect(ids.slice(0, -1)).toEqual(tabStripHubViewIds(true));
    expect(ids[ids.length - 1]).toBe("settings");
    expect(ids).toContain("home");
    expect(ids).toContain("orchestration");
  });

  it("follows the workspace's hidden set and order", () => {
    const ids = hubNavigatorViewIds(true, { order: ["kanban", "home"], hidden: ["git"] });
    expect(ids).not.toContain("git");
    expect(ids.indexOf("kanban")).toBeLessThan(ids.indexOf("home"));
  });

  it("offers no root-bound section to a workspace without a root", () => {
    const ids = hubNavigatorViewIds(false);
    expect(ids).not.toContain("orchestration");
    expect(ids).toContain("kanban");
    expect(ids).toContain("settings");
  });
});

describe("hubNavigatorLabel", () => {
  it("names the agent file and the workspace's settings", () => {
    expect(hubNavigatorLabel({ id: "agent-file", label: "CLAUDE.md" }, "AGENTS.md")).toBe("AGENTS.md");
    expect(hubNavigatorLabel({ id: "settings", label: "Settings" }, "x")).toBe("Workspace settings");
    expect(hubNavigatorLabel({ id: "home", label: "Home" }, "x")).toBe("Home");
  });
});

describe("hub navigator surface", () => {
  const page = Object.values(
    import.meta.glob("../../routes/+page.svelte", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >
  )[0];
  it("is mounted beside the terminal view only", () => {
    expect(page).toMatch(/<HubNavigator[\s\S]*?<TerminalView/);
    expect(page.match(/<HubNavigator/g)).toHaveLength(1);
  });
});
