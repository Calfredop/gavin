import { describe, it, expect } from "vitest";

// The rail header used to be ONE row: name, conflict badges, state word,
// attention chip and six icon buttons. A rail is a 280px grid column as
// soon as the human has a handful of them (`grid-auto-columns:
// minmax(280px, 1fr)`), and the buttons alone eat ~164px of that -- so
// the name, the one thing that says which rail you are reading,
// ellipsised down to a few characters.
//
// The name now has row one and the actions have row two. That is markup
// structure and four CSS declarations, which no rendering test in this
// suite can see, so this pins them the way orchestrationRailScroll pins
// the scroll rules.

const SVELTE = import.meta.glob(["./*.svelte", "./ui/StatusBadge.svelte"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RAIL = "OrchestrationRail.svelte";

function source(name: string): string {
  const text = SVELTE[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The markup of one header row, by its class, up to the element that
/// opens the next one. Comments stripped, so prose naming a component
/// cannot satisfy an assertion about what the row RENDERS.
function row(open: string, close: string): string {
  const text = source(RAIL);
  const from = text.indexOf(open);
  if (from === -1) throw new Error(`no \`${open}\` in ${RAIL}`);
  const to = text.indexOf(close, from);
  if (to === -1) throw new Error(`\`${open}\` is never closed by \`${close}\``);
  return text
    .slice(from + open.length, to)
    .replace(/<!--[\s\S]*?-->/g, "");
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

const NAME_ROW = '<div class="name-row">';
const ACTION_ROW = '<div class="action-row">';

describe("the rail header's first row", () => {
  it("carries the rail's name", () => {
    const first = row(NAME_ROW, ACTION_ROW);
    expect(first).toContain('class="name"');
    expect(first).toContain('class="name-input"');
  });

  it("carries what qualifies the name, and nothing that acts", () => {
    const first = row(NAME_ROW, ACTION_ROW);
    // Conflicts, state and attention describe the rail the name names --
    // they belong beside it, and they are small.
    expect(first).toContain('class="rail-badge');
    // Both are StatusBadges from the shared vocabulary (ui/indicators.ts),
    // the same badge the hub's rail list and the step chips draw.
    expect(first).toContain("indicator={railIndicator(railState)}");
    expect(first).toContain("indicator={attentionIndicator(attention)}");
    // Not one button. This is the whole fix: an action added back to
    // this row starts squeezing the name again.
    expect(first).not.toContain("<IconButton");
  });

  it("lets only the name give width", () => {
    // The name ellipsises; the two labels beside it stay whole. Without
    // `flex: none` a long enough name shrinks THEM first and "needs you"
    // wraps mid-phrase.
    const name = ruleFor(".name");
    expect(name).toContain("min-width: 0");
    expect(name).toContain("text-overflow: ellipsis");
    // The state and attention labels are StatusBadges, and the badge's
    // own rule is what refuses to shrink -- one rule for every badge in
    // the app rather than a private flex: none per surface.
    const badge = SVELTE["./ui/StatusBadge.svelte"];
    expect(badge, "no source for ui/StatusBadge.svelte").toBeTruthy();
    const at = badge.indexOf("\n  .status-badge {");
    expect(at, "no `.status-badge` rule in StatusBadge.svelte").toBeGreaterThan(-1);
    const rule = badge.slice(at, badge.indexOf("}", at)).replace(/\s+/g, " ");
    expect(rule).toContain("flex: 0 0 auto");
  });
});

describe("the rail header's second row", () => {
  it("holds every one of the rail's actions", () => {
    const second = row(ACTION_ROW, '<button type="button" class="bindings"');
    for (const icon of [
      "icon={Play}",
      "icon={Pause}",
      "icon={Sparkles}",
      "icon={RotateCcw}",
      "icon={SquareStack}",
      "icon={BrushCleaning}",
      "icon={Trash2}",
    ]) {
      expect(second).toContain(icon);
    }
  });

  it("is a row, not a wrapping grid", () => {
    // Six bare icon buttons are ~164px; a 280px rail fits them on one
    // line, and a header that reflows to three rows would cost more
    // vertical space than the name gained horizontal.
    const action = ruleFor(".action-row");
    expect(action).toContain("display: flex");
    expect(action).not.toContain("flex-wrap");
  });
});
