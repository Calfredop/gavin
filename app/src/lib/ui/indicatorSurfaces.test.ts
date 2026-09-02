import { describe, it, expect } from "vitest";

// indicators.ts can only promise that the vocabulary is coherent. What it
// cannot see is a surface quietly hand-rolling a badge again -- and that
// is exactly how the app got here: nine files, each with its own 6-8px
// coloured dot, none of them wrong on its own.
//
// So this reads the committed source. Vite hands SSR an empty string for
// a CSS import, and a scoped <style> block is never a module at all, so a
// rendered assertion is impossible; a grep over the files is the only
// thing that can hold this line. Same tactic as chevronSharpening.test.ts.

const SOURCES = import.meta.glob("../../**/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(file: string): string {
  const key = Object.keys(SOURCES).find((k) => k.endsWith(`/${file}`));
  expect(key, `${file} is no longer where this test looks for it`).toBeDefined();
  return SOURCES[key as string];
}

/// A CSS declaration block, so a rule's properties can be read together
/// rather than line by line -- "round" and "filled amber" only matter
/// when they are the same element.
function ruleBlocks(css: string): string[] {
  return [...css.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
}

// The one shape this work retired: small, round, filled with a semantic
// colour, and carrying no glyph -- so its entire meaning is its hue. A
// reader meeting one has to already know which of the app's axes it
// belongs to, which is precisely what nobody could do.
//
// A spinner is round and accent-coloured too, and is NOT this: it has a
// transparent arc, it means one thing everywhere, and it is animated.
function bareColouredDots(css: string): string[] {
  return ruleBlocks(css).filter((block) => {
    if (!/border-radius:\s*50%/.test(block)) return false;
    if (/border-top-color:\s*transparent/.test(block)) return false; // spinner
    const size = block.match(/\bwidth:\s*(\d+)px/);
    if (!size || Number(size[1]) > 10) return false;
    return /background:\s*var\(--(warning|danger|accent|success)/.test(block);
  });
}

/// The corner pip on a hub tab is the deliberate exception. It is not an
/// inline badge competing with others in a row: it sits on a tab that
/// already carries its own icon, its own label, an aria-label and a
/// tooltip, all of which name the fact in words. Nothing there rests on
/// the colour alone.
const ALLOWED_DOTS: Record<string, number> = {
  "+page.svelte": 1,
};

describe("no surface hand-rolls an indicator", () => {
  it("leaves no bare coloured dot outside the one place a pip is right", () => {
    for (const [path, text] of Object.entries(SOURCES)) {
      const file = path.split("/").pop() as string;
      const found = bareColouredDots(text);
      expect(
        found.length,
        `${file} draws ${found.length} colour-only dot(s); use ui/StatusBadge with an indicator from ui/indicators.ts, whose glyph says which question the badge answers`
      ).toBe(ALLOWED_DOTS[file] ?? 0);
    }
  });

  // The five surfaces the card called out by name. Each shows a fact the
  // vocabulary owns, so each has to go through the shared component --
  // not because importing it proves the rendering is right, but because
  // NOT importing it proves the surface went its own way again.
  it.each([
    ["BoardCard.svelte", "a card's priority and its bound agent"],
    ["PlanTree.svelte", "a plan file's priority"],
    ["Pane.svelte", "a terminal tab's agent, checkout and unsaved edits"],
    ["Sidebar.svelte", "page rows, tab rows and the workspace tallies"],
    ["CardDetailModal.svelte", "the card's agent session"],
    // Found by the survey rather than named in the card, and the same
    // disease: the orchestration surfaces had a run-state vocabulary of
    // their own, disagreeing with each other about what `running` looks
    // like even between a step's chip and that step's own card.
    ["OrchestrationStepChip.svelte", "a step's run state and what its agent wants"],
    ["OrchestrationStepCard.svelte", "the same step's run state on the board"],
    ["OrchestrationRail.svelte", "the rail's own state"],
    ["HomeHubView.svelte", "each rail's state in the hub's list"],
  ])("%s draws %s through StatusBadge", (file) => {
    expect(source(file)).toMatch(/import StatusBadge from "\.{1,2}\/(ui\/)?StatusBadge\.svelte"/);
  });

  // The specific collision the card opened with: on the board the amber
  // dot was priority, on a terminal tab the same amber dot was the git
  // state, and the tab bar had a third one for unsaved edits. The tab
  // bar must not go back to naming states by CSS class.
  it("keeps the terminal tab bar out of the dot business", () => {
    const pane = source("Pane.svelte");
    for (const dead of ["status-dot", "dirty-dot", "git-dot"]) {
      expect(pane, `Pane.svelte is drawing a .${dead} again`).not.toContain(dead);
    }
  });

  // The orchestration flavour of the same mistake. These four files each
  // held a private table mapping a run state to a colour -- and the hub's
  // copy said so in a comment, which is how you know a shared vocabulary
  // was overdue. A rule keyed on the state name is that table growing
  // back, whatever it is spelt.
  it.each([
    ["OrchestrationStepChip.svelte", ["running", "done", "stalled", "pending"]],
    ["OrchestrationStepCard.svelte", ["running", "done", "stalled"]],
    ["OrchestrationRail.svelte", ["running", "paused"]],
    ["HomeHubView.svelte", ["running", "paused"]],
  ])("%s no longer colours a state by its name", (file, states) => {
    const css = (source(file).split("<style>")[1] ?? "").split("</style>")[0];
    for (const state of states as string[]) {
      // `.state.running { color: var(--accent-text) }` and friends. Only
      // a TONE token counts: a done chip dimming its own text to
      // --text-muted is saying "finished work recedes", which is a
      // property of the chip, not a second opinion about what the state
      // means. The table this kills is the one that spends the app's
      // five meaning-carrying colours.
      const rule = new RegExp(`\\.(state|chip|rail)[^{}]*\\.${state}\\b[^{}]*\\{([^{}]*)\\}`, "g");
      for (const match of css.matchAll(rule)) {
        expect(
          /(^|;)\s*color:\s*var\(--(accent|warning|danger|success)-text/.test(match[2]),
          `${file} picks a tone for "${state}" itself; the tone belongs to ui/indicators.ts`
        ).toBe(false);
      }
    }
  });
});
