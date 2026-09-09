import { describe, it, expect } from "vitest";
import { svelteSources } from "./sources";

// The hub tab strip's arrangement is one feature spread over four
// surfaces that nothing links: the row itself (+page.svelte), the eye
// list (HubTabsModal), and the two settings panels that open it. Every
// rule they share is invisible to every other suite -- a lock button
// wired to no store renders perfectly, and a panel that opens no modal
// type-checks fine. Both are dead controls, which is the failure this
// pins.
//
// Reads the sources rather than the rendered DOM, following
// hubTabBar.test.ts and autoCommitSurfaces.test.ts: mounting the row to
// assert "this handler is called" tests the harness, and a component
// `<style>` is compiled away anyway.

const LIB = svelteSources();

const ROUTES = import.meta.glob("../routes/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = LIB[name] ?? ROUTES[`../routes/${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const ROW = "+page.svelte";
const MODAL = "HubTabsModal.svelte";
const WORKSPACE_PANEL = "SettingsHubView.svelte";
const APP_PANEL = "GlobalSettingsModal.svelte";

describe("the tab row", () => {
  const row = source(ROW);

  it("draws from the human's own preferences, not from the declaration order", () => {
    // Through tabStripHubViews rather than by filtering here: the
    // ⌘-digit router counts the same function's output, and a row that
    // applied the order itself would let the two drift.
    expect(row).toContain("hubTabPrefsFor(");
    expect(row).toContain("tabStripHubViews(");
    expect(row).toContain("hubTabPrefs");
  });

  it("only lets a tab be dragged while the row is unlocked", () => {
    expect(row).toContain("draggable={$hubTabsUnlocked}");
  });

  it("sets dropEffect on the target's dragover", () => {
    // Without it WKWebView shows the "copy" (+) cursor for the whole
    // drag, whatever effectAllowed the source set.
    expect(row).toContain('event.dataTransfer.dropEffect = "move"');
  });

  it("stores the move through the pure reorder rather than an index", () => {
    expect(row).toContain("moveHubViewId(");
    expect(row).toContain("setWorkspaceHubTabOrder(");
  });

  it("keeps the lock outside the scrolling strip", () => {
    // A narrow window scrolls the tabs; the control that makes them
    // draggable at all must never be the thing it pushes out of reach.
    const stripEnd = row.indexOf("drag-spacer");
    const toggle = row.indexOf("toggleHubTabsUnlocked");
    expect(toggle).toBeGreaterThan(-1);
    expect(toggle).toBeLessThan(stripEnd);
  });

  it("opens a tab's own menu on right-click", () => {
    expect(row).toContain("oncontextmenu={(e) => handleHubTabMenu(e, view.id)}");
    expect(row).toContain("buildHubTabMenuEntries(");
  });

  it("gates that menu on the same padlock as the drag", () => {
    // Hiding a tab is the same kind of edit as moving one. Behind the
    // lock, a right-click on a tab does nothing gavin-specific -- which
    // is the point: a locked row's tabs are buttons.
    expect(row).toContain("if (!$hubTabsUnlocked || !activeWorkspace) return;");
  });

  it("hides into the workspace's own list rather than the app-wide default", () => {
    // A right-click happened in ONE strip; writing the default would
    // rearrange the four rows nobody is looking at.
    expect(row).toContain("setWorkspaceHubTabsHidden(workspaceId, hidden)");
  });

  it("can still reach the full list from the menu", () => {
    // Hiding from the strip has to lead somewhere, or a tab turned off
    // by a right-click is only findable by someone who knows Settings
    // has an eye list.
    expect(row).toContain("HubTabsModal");
    expect(row).toContain("hubTabsPanelOpen");
  });

  it("marks the tab on screen rather than the one merely remembered", () => {
    // A tab hidden while the workspace was parked on it would otherwise
    // keep rendering with nothing in the row underlined.
    expect(row).toContain("class:active={activeViewDef?.id === view.id}");
    expect(row).toContain("drawableViews");
  });
});

describe("both settings panels", () => {
  it("open the same eye list", () => {
    for (const panel of [WORKSPACE_PANEL, APP_PANEL]) {
      expect(source(panel)).toContain("HubTabsModal");
      expect(source(panel)).toContain("hubTabsOpen");
    }
  });

  it("says how many sections are hidden without making the human count eyes", () => {
    expect(source(APP_PANEL)).toContain("hiddenHubViewCount(");
    expect(source(WORKSPACE_PANEL)).toContain("hiddenHubViewCount(");
  });

  // Only the workspace panel has something to inherit; the app-wide one
  // is the level being inherited FROM.
  it("offers the workspace a way back to the default", () => {
    expect(source(WORKSPACE_PANEL)).toContain("hubTabsInherited");
    expect(source(MODAL)).toContain("setWorkspaceHubTabsHidden(workspaceId, null)");
  });
});

describe("the eye list", () => {
  const modal = source(MODAL);

  it("hangs the last-one-left reason on the row, not on the disabled button", () => {
    // tooltip.ts binds mouseenter, which a disabled element never fires:
    // a tooltip on the button itself is a control that cannot explain
    // why it will not act.
    expect(modal).toContain('use:tooltip={locked ? "The last section left has to stay" : ""}');
    expect(modal).toContain("disabled={locked}");
  });

  it("asks the shared rule whether a section may go", () => {
    expect(modal).toContain("canHideHubView(hidden, view.id)");
  });

  it("shows what the strip actually does while a workspace inherits", () => {
    // The eyes start from the effective list, so the first click on an
    // inheriting workspace begins from what it was already showing.
    expect(modal).toContain("$hubTabsHiddenByWorkspace[workspaceId] ?? $hubTabsHiddenDefault");
  });
});
