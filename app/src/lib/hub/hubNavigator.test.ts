import { describe, it, expect } from "vitest";
import {
  hubNavigatorLabel,
  hubNavigatorViewIds,
  loadHubNavigatorSide,
  otherHubNavigatorSide,
  saveHubNavigatorSide,
} from "$lib/hub/hubNavigator";
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

  it("marks the open section with the tab row's accent line, not a box or a close badge", () => {
    const nav = Object.values(
      import.meta.glob("./HubNavigator.svelte", { query: "?raw", import: "default", eager: true }) as Record<
        string,
        string
      >
    )[0];
    expect(nav).not.toContain("close-badge");
    expect(nav).toContain("var(--tab-indicator)) 0 0 0 var(--ws-accent, #d9a648)");
    expect(page).toContain("border-bottom-color: var(--ws-accent, #d9a648)");
  });

  it("keeps the lower tab bar of a column split clear of the bar, on either side", () => {
    expect(page).toContain(
      ":global(.tree .split.column > .child:not(:first-child) .pane-wrapper > .tab-bar:not(.split.row > .child:not(:first-child) *))"
    );
    expect(page).toContain(
      ":global(.tree .split.column > .child:not(:first-child) .pane-wrapper > .tab-bar:not(.split.row > .child:not(:last-child) *))"
    );
  });

  // The margin that clears the bar is aimed at Pane's markup from
  // outside it, so a wrapper added inside Pane silently un-aims it: the
  // tab groups' .pane-body did exactly that, and the bar sat over the
  // page again. Pin the selector to the child Pane actually draws.
  it("makes room for the bar on the pane's body, which Pane draws directly under its wrapper", () => {
    const pane = Object.values(
      import.meta.glob("../panes/Pane.svelte", { query: "?raw", import: "default", eager: true }) as Record<
        string,
        string
      >
    )[0];
    const template = pane.slice(pane.indexOf('<div class="pane-wrapper">'));
    const children = template.match(/^ {2}<div class="([^"]+)"/gm)?.map((m) => m.match(/"([^"]+)"/)![1]);
    expect(children).toContain("pane-body");
    expect(page).toContain(":global(.tree .pane-wrapper > .pane-body:not(.split.row > .child:not(:first-child) *))");
    expect(page).toContain(":global(.tree .pane-wrapper > .pane-body:not(.split.row > .child:not(:last-child) *))");
    expect(page).not.toContain(".pane-wrapper > .content");
  });

  it("is mounted beside the terminal view only", () => {
    expect(page).toMatch(/<HubNavigator[\s\S]*?<TerminalView/);
    expect(page.match(/<HubNavigator/g)).toHaveLength(1);
  });
});

describe("navigator side", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("defaults to left and remembers right", () => {
    const st = mem();
    expect(loadHubNavigatorSide(st)).toBe("left");
    saveHubNavigatorSide("right", st);
    expect(loadHubNavigatorSide(st)).toBe("right");
    expect(otherHubNavigatorSide("right")).toBe("left");
  });
});
