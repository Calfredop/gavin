import { describe, it, expect } from "vitest";
import { svelteSources } from "./sources";

// The card detail panel's LAYOUT, which no unit test can see and no
// rendered-DOM test would catch either: what this pins is where things
// sit relative to each other in the source, because that is what decides
// whether the one urgent control is reachable without scrolling.
//
// The failure it exists for: the panel used to be a single scroll in a
// fixed order -- identity, every editable field, attachments, checklist,
// nested tasks, the card's own text, and only then the agent session. On
// a task whose prompt runs to a paragraph or two that put "Jump to
// session" below the bottom of the panel, so the one card with something
// urgent to say (its agent is waiting for a human) was the one card
// whose button had to be hunted for.
//
// Reads the component source rather than the rendered DOM, following
// autoCommitSurfaces.test.ts: mounting the component to assert "this
// block is above that one" tests the harness, not the panel.

const SOURCES = svelteSources();

const DETAIL = SOURCES["CardDetailModal.svelte"] ?? "";
const MODAL = SOURCES["Modal.svelte"] ?? "";

/// Index of a fragment, asserted present first -- `indexOf` returning -1
/// would otherwise make every ordering assertion below pass by accident.
function at(text: string, fragment: string): number {
  const i = text.indexOf(fragment);
  expect(i, `missing from the source: ${fragment}`).toBeGreaterThan(-1);
  return i;
}

describe("the panel's three bands", () => {
  it("hands scrolling to its own middle rather than to the modal panel", () => {
    expect(DETAIL).toContain("innerScroll");
    // Modal's own prop, so the panel clips and lays out as a column --
    // without it a sticky head would stick to the panel's padding edge
    // with the padding sliding past underneath.
    expect(MODAL).toContain("innerScroll?: boolean;");
    expect(at(DETAIL, '<div class="head">')).toBeLessThan(at(DETAIL, '<div class="scroll"'));
    expect(at(DETAIL, '<div class="scroll"')).toBeLessThan(at(DETAIL, '<div class="foot">'));
  });

  it("scrolls the middle and nothing else", () => {
    // The head and foot are pinned by being flex: 0 0 auto beside a
    // middle that takes the slack. A missing `min-height: 0` on either
    // link of that chain is what turns an inner scroller into a page
    // that grows forever.
    expect(DETAIL).toMatch(/\.scroll \{[^}]*overflow-y: auto;/);
    expect(DETAIL).toMatch(/\.scroll \{[^}]*min-height: 0;/);
    expect(DETAIL).toMatch(/\.head \{[^}]*flex: 0 0 auto;/);
    expect(DETAIL).toMatch(/\.foot \{[^}]*flex: 0 0 auto;/);
    expect(DETAIL).toMatch(/\.card-detail \{[^}]*min-height: 0;/);
  });

  it("resets its own scroller when repointed at another card", () => {
    // Modal's `scrollKey` resets the PANEL, which no longer scrolls. The
    // Tasks list and "Part of" repoint this panel without unmounting it,
    // so without this the reader lands at the offset the previous card
    // was left at.
    expect(DETAIL).toContain("if (scroller) scroller.scrollTop = 0;");
  });
});

describe("the session bar", () => {
  it("sits in the pinned head, above everything the human wrote", () => {
    const bar = at(DETAIL, 'class="session-bar');
    expect(bar).toBeLessThan(at(DETAIL, '<div class="scroll"'));
    // And the card's own text is below it, which is the inversion.
    expect(bar).toBeLessThan(at(DETAIL, '<pre class="prompt">'));
    expect(bar).toBeLessThan(at(DETAIL, '<div class="body-preview">'));
  });

  it("asks cardDetail.ts what the situation is instead of nesting the branches again", () => {
    expect(DETAIL).toContain("cardSessionBar(situation)");
    expect(DETAIL).toContain("runBarAction(action.id)");
  });

  it("keeps the precedence the old nested blocks had", () => {
    // A best-of-N run replaces the binding block (there is no binding
    // until one is picked); a develop run replaces every launch (the
    // file is being rewritten, so every launch is refused).
    const best = at(DETAIL, '{ kind: "best-of-n"');
    const bound = at(DETAIL, 'kind: "bound"');
    const developing = at(DETAIL, '{ kind: "developing" }');
    const unbound = at(DETAIL, 'kind: "unbound"');
    expect(best).toBeLessThan(bound);
    expect(bound).toBeLessThan(developing);
    expect(developing).toBeLessThan(unbound);
  });

  it("accents the first action that can actually be pressed", () => {
    expect(DETAIL).toContain(
      "const primaryActionId = $derived(bar?.actions.find((a) => a.enabled && !a.danger)?.id ?? null);"
    );
    expect(DETAIL).toContain("class:primary={action.id === primaryActionId}");
  });

  it("only tints for the two tones that want something", () => {
    // Colour keeps the one job ui/indicators.ts gives it: amber wants a
    // human, red is broken. A working agent is motion, not an alert, so
    // it gets a border and no ground.
    expect(DETAIL).toMatch(/\.session-bar\.tone-warning \{[^}]*background: var\(--surface-warning\);/);
    expect(DETAIL).toMatch(/\.session-bar\.tone-danger \{[^}]*background: var\(--surface-danger\);/);
    expect(DETAIL).not.toMatch(/\.session-bar\.tone-accent \{[^}]*background:/);
  });
});

describe("what the scroller carries", () => {
  it("puts the explanation directly under the claim it explains", () => {
    // The failure paragraph, the auto-resume trail and the orphan note
    // are what the bar has no room for, so they lead the scroller rather
    // than sitting in a section further down.
    const situation = at(DETAIL, '<div class="situation">');
    expect(at(DETAIL, '<div class="scroll"')).toBeLessThan(situation);
    expect(situation).toBeLessThan(at(DETAIL, '<div class="section">'));
  });

  it("stops capping the card's own text, because nothing urgent is below it now", () => {
    // Two scrollbars inside one another was the price of keeping the
    // session block reachable. The panel scrolls once now.
    const styles = DETAIL.slice(DETAIL.lastIndexOf("<style>"));
    expect(styles).toMatch(/\.prompt \{[^}]*\}/);
    expect(styles).not.toMatch(/\.prompt \{[^}]*max-height:/);
    expect(styles).not.toMatch(/\.body-preview \{[^}]*max-height:/);
  });

  it("folds the two blocks a human comes here to change rather than to read", () => {
    expect(DETAIL).toContain('{@render fold("settings", "Card settings", settingsLine)}');
    expect(DETAIL).toContain('{@render fold("rail", "Orchestration rail", railLine)}');
    // A folded section still says what it holds, or the fold is just a
    // second hunt.
    expect(DETAIL).toContain("settingsSummary({");
    expect(DETAIL).toContain("railSummary({");
    // And the answer outlives the panel, which is destroyed on every
    // close.
    expect(DETAIL).toContain("saveSectionsOpen(sectionsOpen)");
    expect(DETAIL).toContain("loadSectionsOpen()");
  });

  it("keeps every launch out of it", () => {
    // Reaching an agent is the bar's job, and the bar is pinned. If a
    // launch button ever lands back in the scrolling band -- worse, in a
    // section that starts folded -- the card this panel was reworked for
    // is back. The labels themselves live in cardDetail.ts, so their
    // absence here is the whole check.
    const band = DETAIL.slice(at(DETAIL, '<div class="scroll"'), at(DETAIL, '<div class="foot">'));
    for (const label of ["Jump to session", "Re-launch", "Resume this card", "▶ Run "]) {
      expect(band.includes(label), `${label} must not be in the scrolling band`).toBe(false);
    }
    // What the fold DOES carry is evidence, not reach.
    expect(band).toContain("Run history…");
    expect(band).toContain("Changes since ");
  });
});

describe("the pinned foot", () => {
  it("carries the error, so an action can always report where it was pressed", () => {
    const foot = at(DETAIL, '<div class="foot">');
    const error = DETAIL.indexOf("{#if errorMessage}", foot);
    expect(error).toBeGreaterThan(foot);
    expect(error).toBeLessThan(at(DETAIL, '<div class="actions">'));
  });

  it("still holds every card-level action", () => {
    const foot = DETAIL.slice(at(DETAIL, '<div class="foot">'));
    for (const label of ["Delete", "Archive", "Open in card editor", "Open externally", "Close"]) {
      expect(foot).toContain(label);
    }
  });
});
