import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The app's top edge is three bars in three files that have to agree:
// the window's corner and the rail's top line (TitleBar.svelte), the
// workspace's hub tabs (routes/+page.svelte) and a page's session tabs
// (Pane.svelte). Nothing links them, so the drift is invisible to every
// other suite and to a reader of any one of them -- and the drift
// MATTERS now in a way it did not before this milestone: the title bar
// used to span the window and push everything down by its own height, so
// a page's tabs and a hub's tabs never met. They do now. Whichever is on
// screen is the top edge, and the sidebar beside them starts on the line
// that row ends on.
//
// This reads the sources rather than the rendered DOM on purpose: a
// component <style> is compiled away, and vite hands SSR an empty string
// for a CSS import, so the declarations are only legible here.

const SOURCES = svelteSources();

const ROUTES = import.meta.glob("../../routes/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/// One route component by file name. The glob's keys are its own pattern
/// spelled back, so naming a key would pin where THIS file sits -- which
/// is the coupling the source seam exists to remove.
function route(name: string): string {
  const found = Object.entries(ROUTES).find(([path]) => path.endsWith(`/${name}`));
  if (!found) throw new Error(`no source for ${name}`);
  return found[1];
}

/// The variables theme.css defines for these rows. The stylesheet itself
/// is unreadable from here -- vite hands SSR an empty string for a CSS
/// import, `?raw` included, and @types/node is not installed for a
/// browser bundle -- so this is the mirror to keep in step with it, the
/// same arrangement ui/chevronSharpening.test.ts had to settle for.
/// What it is really pinning is that all three rows name the SAME
/// variables: a row that goes back to a literal drifts alone, while a
/// variable that loses its definition breaks all three together and is
/// visible in the first frame.
const METRICS = [
  "--header-height",
  "--header-pad-top",
  "--tab-pad",
  "--tab-font-size",
  "--tab-indicator",
  "--tab-gap",
  "--tab-divider",
];

function source(name: string): string {
  const text = SOURCES[name] ?? route(name);
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The declarations of one rule, by exact selector, as a trimmed map.
/// Crude by design -- none of these bars sits inside a nested at-rule, so
/// "the text between this selector's braces" is the rule.
function rule(componentSource: string, selector: string): Record<string, string> {
  const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(componentSource);
  const css = (style ? style[1] : componentSource).replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map<string, string>();
  for (const [, prelude, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.set(prelude.trim().replace(/\s+/g, " "), body);
  }
  const body = found.get(selector);
  if (body === undefined) {
    throw new Error(`no rule for "${selector}" (saw: ${[...found.keys()].join(", ")})`);
  }
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  return out;
}

const PAGE = source("+page.svelte");
const PANE = source("Pane.svelte");
const TITLE_BAR = source("TitleBar.svelte");
const ACTIONS = source("SidebarActions.svelte");
const OVERHANG = source("CornerOverhang.svelte");

describe("the app's three header rows", () => {
  // One definition, three readers. A literal in any of the three files is
  // how the rows drift apart again.
  it("takes every metric from theme.css rather than restating it", () => {
    const shared = [TITLE_BAR, PAGE, PANE].join("\n");
    for (const name of METRICS) {
      expect(shared).toContain(`var(${name})`);
    }
    for (const strip of [rule(TITLE_BAR, ".corner"), rule(TITLE_BAR, ".rail-top")]) {
      expect(strip.height).toBe("var(--header-height)");
    }
    for (const bar of [rule(PAGE, ".tabs"), rule(PANE, ".tab-bar")]) {
      expect(bar.height).toBe("var(--header-height)");
      // Without border-box the padding would be added to the height and
      // the two bars would differ by exactly it.
      expect(bar["box-sizing"]).toBe("border-box");
      expect(bar.padding.startsWith("var(--header-pad-top)")).toBe(true);
    }
  });

  it("gives a page's tabs the hub tabs' own size", () => {
    const hubTab = rule(PAGE, ".tab");
    const pageTab = rule(PANE, ".tab");
    expect(pageTab.padding).toBe(hubTab.padding);
    expect(pageTab["font-size"]).toBe(hubTab["font-size"]);
    expect(pageTab["font-family"]).toBe(hubTab["font-family"]);
  });

  // Every row across the top of the window is the surface of the view
  // under it, so that top line is one unbroken colour whichever row is on
  // screen -- the window's own corner included. A page's row used to be
  // --surface-raised: a grey band with the active tab cut out of it in
  // black, whose padding read as a margin of the sidebar's grey leaking
  // over the page.
  it("paints both tab rows the surface of the view they open", () => {
    expect(rule(PAGE, ".tabs").background).toBe("var(--surface-base)");
    expect(rule(PANE, ".tab-bar").background).toBe("var(--surface-base)");
    // The window's own line is the exception, at both its widths: the
    // corner is the SIDEBAR's header -- the window's controls and the
    // column's own three buttons, over the column they act on -- so it
    // wears the column's surface, and the line under it matches so the
    // seam never shows.
    expect(rule(TITLE_BAR, ".corner").background).toBe("var(--surface-raised)");
    expect(rule(TITLE_BAR, ".rail-top").background).toBe("var(--surface-raised)");
  });

  // What a flat row costs: the active tab can no longer be a differently
  // coloured box, so nothing but this hairline says where one tab ends.
  // Short of the row's height on purpose -- a full-height rule reads as a
  // frame around each tab, which is the boxed look the flat bar removed.
  it("separates the tabs of both rows with the same short rule", () => {
    const dividers = [rule(PAGE, ".tab + .tab::before"), rule(PANE, ".tab + .tab::before")];
    for (const divider of dividers) {
      expect(divider.height).toBe("var(--tab-divider)");
      expect(divider.width).toBe("1px");
      expect(divider.background).toBe("var(--border)");
      // Centred in the gap between the two tabs it separates, so the
      // gap and the rule can never be set independently.
      expect(divider.left).toBe("calc(var(--tab-gap) / -2)");
      expect(divider.position).toBe("absolute");
    }
    for (const strip of [rule(PAGE, ".tab-strip"), rule(PANE, ".tab-strip")]) {
      expect(strip.gap).toBe("var(--tab-gap)");
    }
    // A fill on the active tab would be the boxed look again, and on a
    // row that is already the view's own colour there is nothing left
    // for it to be filled WITH.
    expect(rule(PANE, ".tab.active").background).toBeUndefined();
    expect(rule(PAGE, ".tab.active").background).toBeUndefined();
  });

  // The page tab's indicator used to be a bar over the tab in a blue of
  // its own; the hub's is the workspace's accent under it. One
  // indicator, one edge, one colour -- including the amber a workspace
  // with no colour set falls back to.
  it("draws both indicators on the edge the tab shares with its view", () => {
    for (const tab of [rule(PAGE, ".tab"), rule(PANE, ".tab")]) {
      expect(tab["border-bottom"]).toBe("var(--tab-indicator) solid transparent");
      expect(tab["border-top"]).toBeUndefined();
    }
    expect(rule(PANE, ".tab.focused")["border-bottom-color"]).toBe(
      rule(PAGE, ".tab.active")["border-bottom-color"]
    );
  });
});

describe("the hub and the page reach the top of the window", () => {
  // The strip is inside the window's own column now, over the sidebar --
  // not a full-width row above everything. That is the whole point of
  // the milestone: a full-width strip cost the view under it its own
  // height, twice over once a page's tabs sat below it as well.
  it("puts the title strip in the rail beside the view, not above it", () => {
    expect(PAGE).toMatch(/<div class="rail">\s*<TitleBar \/>/);
    expect(rule(PAGE, ".rail").width).toBe("var(--rail-width)");
    expect(rule(PAGE, ".app")["--rail-width"]).toBe("var(--sidebar-width)");
    // The divider between the columns runs the full height, so it has to
    // belong to the column rather than to the sidebar inside it.
    expect(rule(PAGE, ".rail")["border-right"]).toBe("1px solid var(--border)");
    expect(rule(source("Sidebar.svelte"), ".sidebar")["border-right"]).toBeUndefined();
  });

  // Both banners are caveats on a working app. They stay above every
  // workspace branch -- but inside the view column, so a banner can
  // never push the traffic lights down the window.
  it("keeps the daemon banners under the window's own strip", () => {
    const rail = PAGE.indexOf('<div class="rail">');
    const main = PAGE.indexOf('<div class="main">');
    const banner = PAGE.indexOf("<DaemonCompatBanner />");
    expect(rail).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(rail);
    expect(banner).toBeGreaterThan(main);
  });
});

// The one geometry that lets the rail collapse to what IT draws: the
// window's controls stopped being part of the sidebar's column and
// became a corner of the top line, free to be wider than the column
// under it. Nothing else may be drawn in the strip that corner hangs
// over -- which is the head of whichever header row is on screen.
describe("the window's corner and the rail under it", () => {

  it("takes the corner out of the column's flow, so it sets no floor", () => {
    const corner = rule(TITLE_BAR, ".corner");
    expect(corner.position).toBe("absolute");
    expect(corner.top).toBe("0");
    expect(corner.left).toBe("0");
    // Over an open column the corner IS that column's top row; over a
    // collapsed one it shrinks to the controls and overhangs.
    expect(corner.width).toBe("max(var(--window-corner-width), var(--rail-width))");
    // The view column's header row is painted later in tree order and
    // would otherwise cover whatever of the corner overhangs the rail.
    expect(corner["z-index"]).toBe("1");
    // The rail is positioned, so "the rail's top-left corner" is what
    // (0, 0) means here -- and it is the window's, the rail being the
    // first thing in the body row.
    expect(rule(PAGE, ".rail").position).toBe("relative");
  });

  it("leaves room at the head of the header row for the overhang", () => {
    // The same two variables the corner and the column are sized from,
    // and the subtraction between them: room for exactly what hangs
    // over, and none at all when the rail is the wider of the two.
    expect(rule(OVERHANG, ".corner-overhang").width).toBe(
      "max(0px, calc(var(--window-corner-width) - var(--rail-width)))"
    );
    expect(rule(PAGE, ".app")["--window-corner-width"]).toBe("76px");
    expect(rule(PAGE, ".app.wide-window-controls")["--window-corner-width"]).toBe("120px");
    expect(PAGE).toContain("class:wide-window-controls={!isMacSync()}");
  });

  it("collapses the rail to what the rail draws, not to the platform's width", () => {
    expect(rule(PAGE, ".app.sidebar-collapsed")["--rail-width"]).toBe(
      "var(--rail-collapsed-width)"
    );
    // The old floor, gone: the strip inside the column is no longer
    // allowed to decide how narrow the column can be.
    expect(rule(PAGE, ".rail")["min-width"]).toBeUndefined();
    expect(rule(PAGE, ".rail")["max-width"]).toBeUndefined();
  });

  // Collapsed, the corner is the controls alone: the toggle moves into
  // the rail itself, where it costs what a workspace row costs, and the
  // two actions that need a full-width column stand down.
  it("moves the collapse toggle into the rail while the rail is collapsed", () => {
    expect(ACTIONS).toContain("{#if !collapsed}");
    expect(ACTIONS).toContain("const collapsed = $derived($sidebarCollapsed);");
    const SIDEBAR = source("Sidebar.svelte");
    expect(SIDEBAR).toMatch(/\{#if showsRail\}[\s\S]*?class="rail-chrome"/);
    expect(SIDEBAR).toContain('aria-label="Expand sidebar"');
    expect(SIDEBAR).toContain("onclick={toggleSidebarCollapsed}");
    // Above the scrolling list rather than in it: it is the only way
    // back to the open column, so it must not scroll away.
    expect(rule(SIDEBAR, ".rail-chrome").flex).toBe("0 0 auto");
  });

  // Everything that acts on the window or on the column is in the
  // corner; the header rows keep only the room it needs. A rule between
  // the two groups would be a rule with nothing but a spacer before it.
  it("leaves the header rows nothing of the chrome but its room", () => {
    expect(TITLE_BAR).toContain("<SidebarActions />");
    for (const text of [PAGE, PANE]) {
      expect(text).toContain("<CornerOverhang />");
      expect(text).not.toContain("<SidebarActions />");
      expect(text).not.toMatch(/<CornerOverhang \/>\s*<span class="divider">/);
    }
  });
});

describe("the tab lists scroll and their actions do not", () => {
  it("scrolls each strip sideways on a plain wheel", () => {
    for (const text of [PAGE, PANE]) {
      expect(text).toContain("use:wheelScrollsSideways");
    }
  });

  it("hides the strips' scrollbars, which would land on the indicator", () => {
    for (const strip of [rule(PAGE, ".tab-strip"), rule(PANE, ".tab-strip")]) {
      expect(strip["overflow-x"]).toBe("auto");
      expect(strip["scrollbar-width"]).toBe("none");
      // Without this the strip cannot shrink below its tabs, and the
      // actions get pushed off the end of the bar instead.
      expect(strip["min-width"]).toBe("0");
    }
  });

  it("pins what follows the tabs, so a full row never hides an action", () => {
    for (const actions of [rule(PAGE, ".tab-actions"), rule(PANE, ".tab-actions")]) {
      expect(actions.flex).toBe("0 0 auto");
    }
  });
});

describe("one row of actions per page", () => {
  // Every pane used to draw its own. On a page split four ways that is
  // four copies of Split/Close across the top of the window, and they
  // are not interchangeable -- each acts on the pane it sits on. The
  // decision is layout.ts's (paneOwnsActions, with its own tests); this
  // pins that the template actually asks.
  it("draws a pane's actions only on the pane that owns them", () => {
    expect(PANE).toContain("paneOwnsActions(getActiveTree($layoutState), leaf, $layoutState.focusedSessionId)");
    expect(PANE).toMatch(/\{#if ownsActions\}\s*<div class="tab-actions">/);
  });

  // The hub row is one per window already, so the gear that replaced the
  // Settings TAB belongs in its actions rather than in the strip.
  it("reaches the workspace's settings from the hub row's actions", () => {
    expect(PAGE).toContain('label="Workspace settings"');
    expect(PAGE).toContain("switchWorkspaceView(activeWorkspace.id, settingsView.id)");
    // The strip is counted from the tab subset, not from every offered
    // view -- otherwise the ⌘-digit badges count a tab that is not there.
    expect(PAGE).toContain("{#each tabViews as view, viewIndex (view.id)}");
    expect(PAGE).toContain("hintDigitFor(viewIndex, tabViews.length)");
  });
});

describe("what the bars carry", () => {
  // The three pane controls read the pane's own active tab. Off the
  // focused session they had to be withdrawn on every hub tab, because
  // the focus survives a switch to Kanban and the pane it names is then
  // nowhere on screen.
  it("gives the pane controls to the pane they act on", () => {
    expect(PANE).toContain('label="Split Right"');
    expect(PANE).toContain('label="Split Down"');
    expect(PANE).toContain('label="Close Pane"');
    expect(PANE).toContain("await splitPane(active, direction)");
    expect(PANE).toContain("await confirmPaneClose(active)");
    // The title bar is window chrome again: controls and a drag handle.
    expect(TITLE_BAR).not.toContain("Split Right");
    expect(TITLE_BAR).not.toContain("Close Pane");
  });

  // What acts on the WINDOW and what acts on the COLUMN share the
  // corner over that column: the platform's controls, then collapse,
  // search and Open workspace. They could not while the corner was in
  // the column's flow -- everything in it was a floor under how narrow
  // the column could collapse -- and out of that flow they are free
  // again, in the 124px the lights leave of an open column's top row.
  it("gives the sidebar's chrome the corner over the sidebar", () => {
    expect(TITLE_BAR).toContain("<SidebarActions />");
    expect(TITLE_BAR).toContain("<WindowControls {macOS} />");
    expect(ACTIONS).toContain("Collapse sidebar");
    expect(ACTIONS).toContain("Open workspace");
  });

  // One instance per window, at the window's top-left corner: the hub
  // row draws it, a page's row draws it on the pane that LEADS the page
  // (never the focused one, which moves), and the branches with no
  // header row of their own get a strip of the same height for it.
  it("reserves the corner's room on whichever row is the window's top edge", () => {
    expect(PAGE).toContain("<CornerOverhang />");
    expect(PANE).toContain("<CornerOverhang />");
    expect(PANE).toContain("paneLeadsWindow(getActiveTree($layoutState), leaf)");
    expect(PANE).toMatch(/\{#if leadsWindow\}\s*<CornerOverhang \/>/);
    expect(rule(PAGE, ".chrome-row").height).toBe("var(--header-height)");
    expect(rule(PAGE, ".chrome-row")["box-sizing"]).toBe("border-box");
    expect(rule(PAGE, ".chrome-row").padding.startsWith("var(--header-pad-top)")).toBe(true);
  });

  it("offers New page from both rows, and nowhere spells it on the button", () => {
    for (const text of [PAGE, PANE]) {
      expect(text).toContain("<NewPageButton />");
    }
    // The words moved into the menu's heading (newPage.ts); a worded
    // button would reflow a row of tabs every time it appeared.
    expect(source("NewPageButton.svelte")).not.toContain('text="New page"');
  });

  // What the window lost with the full-width strip: room to grab it.
  // Every row that can be the window's top edge hands its leftover back,
  // a page's tab row included -- press the bar right of the last tab and
  // the WINDOW moves, the way an empty toolbar does on macOS. That run
  // used to start a whole-pane drag instead: an unnamed gesture sitting
  // on the one surface the human reaches for to move the window, on a
  // row where a single tab leaves almost nothing else. Dragging a TAB is
  // what survives, and it starts on the tab.
  it("hands every row's leftover to the window, a pane's row included", () => {
    expect(TITLE_BAR).toContain("use:windowDrag");
    for (const text of [PAGE, PANE]) {
      expect(text).toContain('<div class="drag-spacer" use:windowDrag>');
      // The strip grows only as far as its tabs: what it does not claim
      // belongs to the spacer, rather than being dead bar inside a
      // scroller.
      expect(rule(text, ".tab-strip").flex).toBe("0 1 auto");
      expect(rule(text, ".drag-spacer").flex).toBe("1 1 auto");
    }
    // The tab keeps its own drag -- that is the one this row is for.
    // Nothing around it is a drag source any more, so no press on the
    // bar can mean two things at once.
    expect(PANE).toContain("ondragstart={(e) => handleTabDragStart(e, sessionId)}");
    expect(PANE).not.toContain("handlePaneDragStart");
  });

  // And what a dialog took back: the backdrop is fixed over the whole
  // window, so while one is up it covers every row above -- there was
  // nowhere left to grab the window, and the one gesture the backdrop
  // did have dismissed the dialog. A press that MOVES is a window drag
  // now; a press that does not is still the dismissal.
  it("lets a modal backdrop move the window it covers", () => {
    const modal = source("Modal.svelte");
    expect(modal).toContain("use:windowDragOrClick={backdropClick}");
    expect(modal).not.toContain("onclick={handleBackdropClick}");
    // An inline panel is a pane, not a dialog: it covers nothing, and a
    // click outside must not close it.
    expect(modal).toContain("const backdropClick = $derived(inline ? null : () => onClose());");
  });
});
