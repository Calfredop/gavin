import { describe, it, expect } from "vitest";
import { svelteSources } from "./sources";

// A pin is one rule expressed in three places that nothing links: the
// ordering helpers (workspace.ts), the menu that sets it (sidebarMenu.ts)
// and the rows that obey it (Sidebar.svelte). Only the first two have
// suites of their own. The third is where the rule actually has to hold
// -- a row that still renders its X, or still accepts a reorder drop,
// type-checks and renders perfectly while quietly breaking the one
// promise a pin makes -- so this file reads the component source, the
// way autoCommitSurfaces.test.ts and hubTabBar.test.ts do.

const SOURCES = svelteSources();

const sidebar = (): string => {
  const text = SOURCES["Sidebar.svelte"];
  if (!text) throw new Error("no source for Sidebar.svelte");
  return text;
};

describe("the sidebar draws both lists through the shared order", () => {
  // Not `ws.pages` and not a local sort: the ⌘⇧-number router counts
  // these same rows, and the only way a badge and its shortcut cannot
  // disagree is if both go through the one helper.
  it("renders pages via sidebarPageOrder", () => {
    expect(sidebar()).toContain("{#each orderedPages(ws) as page, pageIndex (page.id)}");
    expect(sidebar()).toContain("return sidebarPageOrder(ws.pages);");
  });

  it("renders workspaces via sidebarWorkspaceOrder", () => {
    expect(sidebar()).toContain("sidebarWorkspaceOrder($layoutState.workspaces, $scratchpadEnabled)");
  });
});

describe("a pinned row cannot be closed", () => {
  // The X is GONE, not disabled. A disabled close still offers the
  // action a pin exists to withdraw, and this app has no way to hang a
  // reason on a disabled control anyway (tooltip.ts binds mouseenter,
  // which a disabled element never fires).
  it("swaps the workspace X for Unpin", () => {
    expect(sidebar()).toContain("{#if wsPinned}");
    expect(sidebar()).toMatch(/\{#if wsPinned\}[\s\S]*?label="Unpin"[\s\S]*?\{:else\}[\s\S]*?class="close-workspace"/);
  });

  it("swaps the page X for Unpin", () => {
    expect(sidebar()).toMatch(/\{#if pagePinned\}[\s\S]*?label="Unpin"[\s\S]*?\{:else\}[\s\S]*?class="close-page"/);
  });

  // Unpin has to actually unpin. A marker glyph wired to nothing would
  // satisfy every assertion above and leave the row permanently stuck.
  it("wires both Unpin buttons to their setters", () => {
    expect(sidebar()).toContain("void setWorkspacePinned(ws.id, false)");
    expect(sidebar()).toContain("void setPagePinned(ws.id, page.id, false)");
  });
});

describe("a pinned row is not part of the reorderable list", () => {
  // Where a pinned row sits is decided by its pin, so a drag that
  // appeared to move it would silently rewrite the stored order without
  // moving anything on screen.
  it("refuses to drag either row kind", () => {
    expect(sidebar()).toContain("draggable={editingWorkspaceId !== ws.id && !wsPinned}");
    expect(sidebar()).toContain("draggable={editingPageId !== page.id && !pagePinned}");
  });

  it("refuses a workspace reorder onto one", () => {
    expect(sidebar()).toContain('if (kind === "workspace" && !isReorderable(workspaceId)) return;');
    expect(sidebar()).toContain("return !!ws && !isPinned(ws);");
  });

  it("refuses a page reorder onto one, in the dragover and again at the drop", () => {
    expect(sidebar()).toContain('if (kind === "page" && isPinned(page)) return;');
    expect(sidebar()).toContain("if (isPinned(page)) return;");
  });

  // The drop index must come from the AUTHORITATIVE array: movePage
  // indexes ws.pages, and the loop index stopped meaning that the moment
  // pinned pages started rendering out of stored order.
  it("resolves the page drop index off ws.pages, not the loop index", () => {
    expect(sidebar()).toContain("const index = ws.pages.findIndex((p) => p.id === page.id);");
    expect(sidebar()).not.toContain("handlePageDrop(e, ws, page, pageIndex)");
  });
});

describe("the Scratchpad keeps its own identity", () => {
  // Its row was called `pinned` before a real pin existed. One class for
  // both would have made every workspace the human pinned italic and
  // muted -- the Scratchpad saying "this is the drawer, not a project",
  // which is not what a pin means.
  it("no longer shares the word with a pinned row", () => {
    expect(sidebar()).toContain('class="workspace-row scratchpad"');
    expect(sidebar()).not.toContain('class="workspace-row pinned"');
    expect(sidebar()).not.toContain(".workspace-row.pinned");
  });
});
