import { describe, it, expect, vi } from "vitest";
import { buildHubTabMenuEntries, type HubTabMenuContext } from "$lib/hubTabMenu";
import { isMenuItem, type ContextMenuEntry, type ContextMenuItem } from "$lib/contextMenu";
import { manageableHubViewIds } from "$lib/hubViewMeta";

function ctx(over: Partial<HubTabMenuContext> = {}): HubTabMenuContext {
  return {
    viewId: "kanban",
    hasRoot: true,
    hidden: [],
    order: null,
    agentFile: "CLAUDE.md",
    ...over,
  };
}

function items(entries: ContextMenuEntry[]): ContextMenuItem[] {
  return entries.filter(isMenuItem);
}

function labels(entries: ContextMenuEntry[]): string[] {
  return items(entries).map((e) => e.label);
}

function pick(entries: ContextMenuEntry[], label: string): void {
  const item = items(entries).find((e) => e.label === label);
  if (!item) throw new Error(`no entry ${label} in ${labels(entries).join(", ")}`);
  item.onPick();
}

const hooks = () => ({ setHidden: vi.fn(), manage: vi.fn() });

describe("the hub tab menu", () => {
  it("hides the tab it was opened on", () => {
    const h = hooks();
    pick(buildHubTabMenuEntries(ctx({ viewId: "git" }), h), "Hide Git");
    expect(h.setHidden).toHaveBeenCalledWith(["git"]);
  });

  it("adds to the set the strip is already following", () => {
    // The effective list comes in, so the first hide on a workspace that
    // inherits the app-wide default keeps everything that default hid.
    const h = hooks();
    pick(buildHubTabMenuEntries(ctx({ viewId: "git", hidden: ["prd"] }), h), "Hide Git");
    expect(h.setHidden).toHaveBeenCalledWith(["prd", "git"]);
  });

  it("refuses to empty the strip in front of it", () => {
    // A workspace with no root draws Kanban alone -- every other section
    // needs the root. Hiding it is legal by the manageable-list rule and
    // would still leave the row exactly as it was, because
    // tabStripHubViewIds ignores a hidden set that hides everything.
    const entries = buildHubTabMenuEntries(ctx({ viewId: "kanban", hasRoot: false }), hooks());
    expect(items(entries).find((e) => e.label === "Hide Kanban")?.disabled).toBe(true);
  });

  it("refuses to hide the last section overall", () => {
    const hidden = manageableHubViewIds().filter((id) => id !== "kanban");
    const entries = buildHubTabMenuEntries(ctx({ viewId: "kanban", hidden }), hooks());
    expect(items(entries).find((e) => e.label === "Hide Kanban")?.disabled).toBe(true);
  });

  it("offers a way back for every tab this workspace is hiding", () => {
    const entries = buildHubTabMenuEntries(ctx({ hidden: ["home", "plans"] }), hooks());
    expect(labels(entries)).toContain("Show Home");
    expect(labels(entries)).toContain("Show Plans");
  });

  it("lists the ways back in the order the strip would draw them", () => {
    const entries = buildHubTabMenuEntries(
      ctx({ hidden: ["home", "plans"], order: ["plans", "home"] }),
      hooks()
    );
    expect(labels(entries).filter((l) => l.startsWith("Show "))).toEqual([
      "Show Plans",
      "Show Home",
    ]);
  });

  it("puts a hidden tab back", () => {
    const h = hooks();
    pick(buildHubTabMenuEntries(ctx({ hidden: ["home", "plans"] }), h), "Show Home");
    expect(h.setHidden).toHaveBeenCalledWith(["plans"]);
  });

  it("does not offer to show a tab this workspace could not draw anyway", () => {
    // Git needs a bound root. Un-hiding it here would put nothing in the
    // row; the eye list is where a section the workspace cannot offer
    // yet is turned back on.
    const entries = buildHubTabMenuEntries(ctx({ hasRoot: false, hidden: ["git"] }), hooks());
    expect(labels(entries)).not.toContain("Show Git");
  });

  it("names the agent-file tab after the file this workspace's agent reads", () => {
    const entries = buildHubTabMenuEntries(
      ctx({ viewId: "agent-file", agentFile: "AGENTS.md" }),
      hooks()
    );
    expect(labels(entries)).toContain("Hide AGENTS.md");
  });

  it("always leads to the full list", () => {
    // Hiding from the strip is a shortcut into a panel, never a second
    // place the answer lives -- so the panel is one pick away even when
    // this tab is the one that may not go.
    const h = hooks();
    const entries = buildHubTabMenuEntries(ctx({ viewId: "kanban", hasRoot: false }), h);
    expect(labels(entries).at(-1)).toBe("Hub tabs…");
    pick(entries, "Hub tabs…");
    expect(h.manage).toHaveBeenCalled();
  });
});
