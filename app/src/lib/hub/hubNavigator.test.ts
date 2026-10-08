import { describe, it, expect } from "vitest";
import { hubNavigatorLabel, hubNavigatorViewIds } from "$lib/hub/hubNavigator";
import { tabStripHubViewIds } from "$lib/hub/hubViewMeta";

describe("hubNavigatorViewIds", () => {
  it("is the strip's list, without Settings", () => {
    const ids = hubNavigatorViewIds(true);
    expect(ids).toEqual(tabStripHubViewIds(true));
    expect(ids).not.toContain("settings");
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
  });
});

describe("hubNavigatorLabel", () => {
  it("names the agent file", () => {
    expect(hubNavigatorLabel({ id: "agent-file", label: "CLAUDE.md" }, "AGENTS.md")).toBe("AGENTS.md");
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
  it("shows a section over the page without switching the workspace's view", () => {
    const nav = Object.values(
      import.meta.glob("./HubNavigator.svelte", { query: "?raw", import: "default", eager: true }) as Record<
        string,
        string
      >
    )[0];
    expect(nav).not.toContain("switchWorkspaceView");
    expect(page).toContain("navigatorView");
  });

  it("is mounted beside the terminal view only", () => {
    expect(page).toMatch(/<HubNavigator[\s\S]*?<TerminalView/);
    expect(page.match(/<HubNavigator/g)).toHaveLength(1);
  });
});
