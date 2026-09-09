import { describe, it, expect } from "vitest";
import { allSources } from "./sources";

// Moving a tab from one pane to another is a drop on the target pane's
// TAB BAR. Nothing type-checks which element carries that drop, and the
// failure of getting it wrong is not an error: the drop lands on the
// pane's body instead, which is the 5-zone graft surface, so the tab
// SPLITS the pane rather than joining it -- the exact outcome this
// gesture exists to offer an alternative to.
//
// Reads sources rather than the rendered DOM, following
// cardTabSurfaces.test.ts: WKWebView is where drag semantics actually
// have to hold, and a jsdom drag proves nothing about it.

const SOURCES = allSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const PANE = "Pane.svelte";

describe("the tab bar takes the drop", () => {
  it("hangs dragover/drop on the bar, so its empty run answers too", () => {
    const text = source(PANE);
    const bar = text.slice(text.indexOf('class="tab-bar"'), text.indexOf('{#if leadsWindow}'));
    expect(bar).toContain("ondragover={handleBarDragOver}");
    expect(bar).toContain("ondrop={handleBarDrop}");
    expect(bar).toContain("ondragleave={handleBarDragLeave}");
  });

  it("leaves the individual tabs as drag SOURCES only", () => {
    const text = source(PANE);
    // A tab that handled dragover itself would have to stopPropagation to
    // avoid double work, and that is precisely what kept the bar from
    // ever seeing the event.
    expect(text).toContain("ondragstart={(e) => handleTabDragStart(e, sessionId)}");
    expect(text).not.toContain("handleTabDragOver");
    expect(text).not.toContain("handleTabDrop");
  });

  it("measures against the tabs the strip actually draws", () => {
    // leaf.tabs is the wrong ruler: the strip scrolls sideways, so where
    // a tab IS on screen is a question only its own rect answers.
    expect(source(PANE)).toContain('querySelectorAll<HTMLElement>(".tab-strip > .tab")');
  });

  it("obeys the caret it drew, rather than appending", () => {
    const text = source(PANE);
    expect(text).toContain("targetIndex: insertion.index");
    // And converts to moveTabWithinLeaf's post-removal coordinates for a
    // same-pane reorder, which the old per-tab handler never did.
    expect(text).toContain("insertion.index > from ? insertion.index - 1 : insertion.index");
  });

  it("tints the whole bar while it is the target, not just one tab", () => {
    const text = source(PANE);
    expect(text).toContain("class:drop-target={tabReorderState !== null}");
    expect(text).toContain(".tab-bar.drop-target");
  });
});
