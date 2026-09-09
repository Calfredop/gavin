import { describe, it, expect } from "vitest";

import { closeWindowPrompt } from "$lib/appClose";
import { svelteSources } from "$lib/sources";

// "A workspace is on screen in exactly one window" is a rule spread over
// five files that nothing links: the registry (workspace_window.rs), the
// rules (appWindow.ts), the guard (layoutState.ts) and the two surfaces
// that offer the action -- the sidebar's workspace menu and the hub tab
// row. The unit suites cover the first three. What no suite can see is a
// button wired to nothing, a sidebar that quietly drops the rows for
// workspaces in other windows, or a workspace window that asks the main
// window's "are you sure you want to quit" question on the way out.
//
// Reads the component sources rather than the rendered DOM, following
// appHeader.test.ts: mounting the whole app to assert "this handler is
// called" tests the harness, and a component `<style>` is compiled away.

const SOURCES = svelteSources();

const ROUTES = import.meta.glob("../routes/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const PAGE = ROUTES["../routes/+page.svelte"] ?? "";
const BUTTON = source("OpenInWindowButton.svelte");
const SIDEBAR = source("Sidebar.svelte");

describe("the hub tab row's window button", () => {
  // Where the card put it, and for a reason worth pinning: both buttons
  // act on the workspace rather than on what is inside it, and this one
  // decides WHERE the workspace is before the other adds to it.
  it("sits in the tab actions, before the New page +", () => {
    const actions = PAGE.slice(PAGE.indexOf('<div class="tab-actions">'));
    const mine = actions.indexOf("<OpenInWindowButton />");
    const plus = actions.indexOf("<NewPageButton />");
    expect(mine).toBeGreaterThan(-1);
    expect(plus).toBeGreaterThan(-1);
    expect(mine).toBeLessThan(plus);
  });

  // Through layoutState, never straight to the backend: the ORDER of the
  // hand-off (look away, drop the terminals, then ask for the window) is
  // the whole of what keeps two panes off one PTY, and a surface that
  // called openWorkspaceWindow itself would skip all of it.
  it("goes through handOffWorkspace", () => {
    expect(BUTTON).toContain("handOffWorkspace(activeWorkspace.id)");
    expect(BUTTON).not.toContain("openWorkspaceWindow");
  });

  // The two surfaces must never disagree about what the action is called,
  // or offer a second window onto a workspace that already has one.
  it("takes its wording from windowActionLabel, like the sidebar menu does", () => {
    expect(BUTTON).toContain("windowActionLabel(");
    expect(BUTTON).not.toContain('label="Open in New Window"');
  });

  // A null label means there is nothing to offer -- this window IS that
  // workspace's window. The button withdraws rather than sitting there
  // doing nothing; a tab row that keeps a dead control is a row you stop
  // reading.
  it("withdraws entirely when there is nothing to offer", () => {
    expect(BUTTON).toContain("{#if label}");
  });
});

describe("the sidebar", () => {
  // The sidebar is the whole fleet, not this window's share of it.
  // Filtering the rows out would leave a workspace with no way back to
  // it from anywhere except the window it is already in.
  it("marks a workspace that is in another window instead of hiding it", () => {
    expect(SIDEBAR).toContain("inAnotherWindow(ws)");
    expect(SIDEBAR).toContain('class:elsewhere={inAnotherWindow(ws)}');
    expect(SIDEBAR).not.toContain("filter((w) => !inAnotherWindow");
  });

  // The mark has to name its own axis: a glyph on its own reads as one
  // more coloured dot, which is the thing ui/indicators.ts exists to have
  // ended.
  it("says what the mark means", () => {
    expect(SIDEBAR).toContain("In another window");
  });
});

describe("closing a workspace window", () => {
  // The prompt exists because closing the main window is how you put
  // gavin away. A workspace window puts nothing away: its workspaces go
  // straight back to the window they came from and no session is touched,
  // so asking would be a question with no stake in it.
  //
  // The wording itself is no longer in this file to look for: it is data
  // in appClose.ts now (closeWindowPrompt, and appClose.test.ts reads
  // it). What is still a question about WINDOWS, and still only visible
  // here, is that the guard returns before anything raises it.
  it("asks nothing, unlike the main window", () => {
    expect(PAGE).toContain("if (!isMainWindow()) return;");
    const guard = PAGE.indexOf("if (!isMainWindow()) return;");
    const prompt = PAGE.indexOf("confirmWindowClose()");
    expect(guard).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(guard);
    expect(closeWindowPrompt().title).toBe("Close this window?");
  });
});
