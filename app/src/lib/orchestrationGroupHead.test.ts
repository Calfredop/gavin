import { describe, it, expect } from "vitest";
import { svelteSources } from "./sources";

// A group's header was ONE row: grip, name, the sequence/parallel toggle
// and the ⋯ menu. The toggle and menu are ~145px of fixed width, and a
// rail is 280px wide as soon as the human has a handful of them, so on
// a narrow rail the name -- the only thing that says what the group IS
// -- ellipsised down to a few characters, or to nothing.
//
// The header now wraps: the toggle and the menu drop to a second row
// exactly when the name's full text would otherwise be cut, and the name
// keeps to one row, ellipsising only once even the whole width is too
// narrow for it. That is markup structure and five CSS declarations no
// rendering test here can see, so this pins them the way
// orchestrationRailHeader pins the rail header's two rows.

const SVELTE = svelteSources();

const RAIL = "OrchestrationRail.svelte";

function source(name: string): string {
  const text = SVELTE[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The markup between two markers, comments stripped, so prose naming a
/// component cannot satisfy an assertion about what the header RENDERS.
function between(open: string, close: string): string {
  const text = source(RAIL);
  const from = text.indexOf(open);
  if (from === -1) throw new Error(`no \`${open}\` in ${RAIL}`);
  const to = text.indexOf(close, from);
  if (to === -1) throw new Error(`\`${open}\` is never closed by \`${close}\``);
  return text.slice(from + open.length, to).replace(/<!--[\s\S]*?-->/g, "");
}

/// The declaration block of one CSS rule, by selector, whitespace
/// collapsed so a reformat does not fail the suite.
function ruleFor(selector: string): string {
  const text = source(RAIL);
  const at = text.indexOf(`\n  ${selector} {`);
  if (at === -1) throw new Error(`no \`${selector}\` rule in ${RAIL}`);
  const open = text.indexOf("{", at);
  const close = text.indexOf("}", open);
  return text.slice(open + 1, close).replace(/\s+/g, " ").trim();
}

const HEAD = '<div class="group-head"';
const TITLE = '<div class="group-title">';
const TOGGLE = '<div class="mode-toggle"';

describe("a group header's title block", () => {
  it("holds the grip and the name, and nothing that acts", () => {
    const title = between(TITLE, TOGGLE);
    expect(title).toContain('class="grip"');
    expect(title).toContain('class="group-name"');
    expect(title).toContain('class="group-name-input"');
    // The toggle and the menu are what wrap; inside this block they
    // would ride the name's row and squeeze it again.
    expect(title).not.toContain("<IconButton");
    expect(title).not.toContain("mode-toggle");
  });

  it("is what the toggle and menu wrap around", () => {
    // The head is the wrapping container, and the title block is its
    // first item -- so the second row, when there is one, is the
    // controls and only the controls.
    const head = between(HEAD, TITLE);
    expect(head.trim()).toMatch(/^title=\{[^}]*\}>\s*$/);
  });

  it("wraps the controls exactly when the name's full text does not fit", () => {
    expect(ruleFor(".group-head")).toContain("flex-wrap: wrap");
    const title = ruleFor(".group-title");
    // `flex-basis: auto` with no shrink makes the block's hypothetical
    // size the name's FULL text: the flex line breaks before the toggle
    // when that text plus the controls overflow, and never when a
    // shorter name leaves room. `max-width: 100%` is the "max one row":
    // a name longer than the whole header still takes one line, and
    // the ellipsis below cuts it there.
    expect(title).toContain("flex: 1 0 auto");
    expect(title).toContain("max-width: 100%");
    expect(title).toContain("min-width: 0");
  });

  it("keeps the name to one row", () => {
    const name = ruleFor(".group-name");
    expect(name).toContain("white-space: nowrap");
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("min-width: 0");
  });

  it("puts the controls at the row's end on either row", () => {
    // On the one-row layout the title block grows into the free space
    // anyway; on the two-row layout this is what keeps the toggle and
    // menu at the right edge instead of hanging under the grip.
    expect(ruleFor(".mode-toggle")).toContain("margin-left: auto");
  });
});
