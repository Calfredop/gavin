import { describe, it, expect } from "vitest";
import { closeIdlePrompt, idleTabsOnPage } from "$lib/panes/idleTabs";
import { pageAgentsSummary, type PageTabState } from "$lib/sidebar/sidebarSummary";
import type { LayoutNode } from "$lib/panes/layout";
import type { Page } from "$lib/workspace";
import { source } from "$lib/sources";

const leaf = (tabs: string[], pinned?: string[]): LayoutNode => ({
  type: "leaf",
  tabs,
  activeTabIndex: 0,
  ...(pinned ? { pinned } : {}),
});
const page = (layout: LayoutNode, name = "Page 1"): Page => ({
  id: "p1",
  name,
  layout,
  focusedSessionId: null,
});
const state = (extra: Partial<PageTabState> = {}): PageTabState => ({
  sessionStatusById: {},
  fileTabsById: {},
  cardTabsById: {},
  boardTabsById: {},
  ...extra,
});

describe("idleTabsOnPage", () => {
  it("takes the sessions that are neither working nor waiting, in layout order", () => {
    const p = page({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["a", "b"]), leaf(["c", "d"])],
    } as LayoutNode);
    const idle = idleTabsOnPage(
      p,
      state({ sessionStatusById: { b: "working", c: "waiting_for_input", d: "idle" } })
    );
    expect(idle.ids).toEqual(["a", "d"]);
    expect(idle.busy).toBe(2);
  });

  it("counts a session that has never reported a status as idle", () => {
    const idle = idleTabsOnPage(page(leaf(["a"])), state());
    expect(idle.ids).toEqual(["a"]);
    expect(idle.busy).toBe(0);
  });

  // The page row's recap and this menu entry must never disagree about
  // the word "idle" -- that is the whole reason the selection is defined
  // over sessionTabsOnly and the same status buckets.
  it("agrees with the sidebar recap's idle tally", () => {
    const p = page(leaf(["a", "b", "f", "k"]));
    const s = state({
      sessionStatusById: { a: "working" },
      fileTabsById: { f: {} },
      boardTabsById: { k: {} },
    });
    expect(idleTabsOnPage(p, s).ids.length).toBe(pageAgentsSummary(p, s).idle);
  });

  it("leaves file and board tabs alone", () => {
    const p = page(leaf(["a", "f", "k"]));
    const idle = idleTabsOnPage(p, state({ fileTabsById: { f: {} }, boardTabsById: { k: {} } }));
    expect(idle.ids).toEqual(["a"]);
    expect(idle.other).toBe(2);
  });

  it("spares a pinned idle tab and reports it", () => {
    const idle = idleTabsOnPage(page(leaf(["a", "b"], ["a"])), state());
    expect(idle.ids).toEqual(["b"]);
    expect(idle.pinned).toEqual(["a"]);
  });

  it("counts the panes a batch would empty", () => {
    const p = page({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["a", "b"]), leaf(["c"])],
    } as LayoutNode);
    const idle = idleTabsOnPage(p, state({ sessionStatusById: { b: "working" } }));
    expect(idle.ids).toEqual(["a", "c"]);
    expect(idle.emptiedPanes).toBe(1);
    expect(idle.emptiesPage).toBe(false);
  });

  it("sees when the batch is the whole page", () => {
    const idle = idleTabsOnPage(page(leaf(["a", "b"])), state());
    expect(idle.emptiesPage).toBe(true);
  });

  it("empties nothing when there is nothing idle", () => {
    const idle = idleTabsOnPage(page(leaf(["a"])), state({ sessionStatusById: { a: "working" } }));
    expect(idle.ids).toEqual([]);
    expect(idle.emptiedPanes).toBe(0);
    expect(idle.emptiesPage).toBe(false);
  });
});

describe("closeIdlePrompt", () => {
  it("names the page and the count on both the title and the button", () => {
    const p = page(leaf(["a", "b"]), "Rail: auth");
    const prompt = closeIdlePrompt(p, idleTabsOnPage(p, state()));
    expect(prompt.title).toBe('Close 2 idle tabs on "Rail: auth"?');
    expect(prompt.confirmLabel).toBe("Close 2 tabs");
    expect(prompt.lines[0]).toContain("Ends 2 terminal sessions");
  });

  it("accounts for every tab it is not closing", () => {
    const p = page(leaf(["a", "busy", "pin", "f"], ["pin"]));
    const s = state({ sessionStatusById: { busy: "working" }, fileTabsById: { f: {} } });
    const lines = closeIdlePrompt(p, idleTabsOnPage(p, s)).lines.join("\n");
    expect(lines).toContain("1 tab working or waiting on you stays open.");
    expect(lines).toContain("1 pinned tab is idle too and stays");
    expect(lines).toContain("1 file or board tab stays");
  });

  it("says the page goes when the batch is every tab, and does not also talk about panes", () => {
    const p = page(leaf(["a", "b"]));
    const lines = closeIdlePrompt(p, idleTabsOnPage(p, state())).lines.join("\n");
    expect(lines).toContain("every tab on this page — the page closes with them");
    expect(lines).not.toContain("pane");
  });

  it("warns about a pane that survives the page", () => {
    const p = page({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["a"]), leaf(["busy"])],
    } as LayoutNode);
    const lines = closeIdlePrompt(p, idleTabsOnPage(p, state({ sessionStatusById: { busy: "working" } }))).lines;
    expect(lines.join("\n")).toContain("1 pane is left empty and closes too.");
  });

  it("says nothing about tabs that are not there", () => {
    const p = page(leaf(["a"]));
    expect(closeIdlePrompt(p, idleTabsOnPage(p, state())).lines).toHaveLength(2);
  });
});

// The one part of this feature no unit test reaches: the sidebar has to
// mount the app's own prompt (not a native confirm), pass it the live
// tab state so "idle" is computed against running agents, and close
// through closeTabsNow -- closeTabs would ask a second time.
describe("Sidebar close-idle wiring", () => {
  const sidebar = source("Sidebar.svelte");

  it("builds the page menu against the live tab state", () => {
    expect(sidebar).toContain("buildPageMenuEntries(ws, page, $layoutState.workspaces, $layoutState, menuHooks())");
  });

  it("raises the app's own ConfirmPrompt from the hook", () => {
    expect(sidebar).toContain("confirmCloseIdle: (request) => (closeIdle = request)");
    expect(sidebar).toContain("<ConfirmPrompt");
    expect(sidebar).toContain("title={pending.prompt.title}");
  });

  it("closes the frozen list without asking again", () => {
    expect(sidebar).toContain("void closeTabsNow(pending.ids)");
  });
});
