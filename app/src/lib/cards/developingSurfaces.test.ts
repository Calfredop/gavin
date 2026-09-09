import { describe, it, expect } from "vitest";
import { cardSessionBar } from "$lib/cards/cardDetail";
import { svelteSources, tsSources } from "$lib/sources";

// One fact -- "an agent is rewriting this card" -- expressed on three
// board surfaces that nothing links: the card face, its context menu and
// its detail modal. The rules themselves are unit-tested in
// developingCards.test.ts and the refusals in cardRunActions.test.ts;
// what no other suite can see is whether a surface actually asks.
//
// The failure this pins is the one the card was filed for: a card whose
// develop run is invisible renders perfectly, and its Run button looks
// exactly like a working one right up until it destroys the interview.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts: mounting three components to assert "this
// handler is called" tests the harness.

const SOURCES = svelteSources();

const MODULES = tsSources();

function source(name: string): string {
  const text = SOURCES[name] ?? MODULES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const CARD = "BoardCard.svelte";
const DETAIL = "CardDetailModal.svelte";
const COLUMN = "KanbanColumn.svelte";
const MENU = "cardMenu.ts";

describe("the board card", () => {
  it("asks the one lookup, from the store, like the session dot beside it", () => {
    const text = source(CARD);
    expect(text).toContain('developingRunIn($layoutState, workspaceId, card.id)');
  });

  it("draws the shared badge rather than inventing a glyph", () => {
    // ui/indicators.ts is the app's one badge vocabulary: shape says
    // which question, tone says the answer.
    expect(source(CARD)).toContain("agentDevelopingIndicator()");
  });

  it("kills BOTH run pills, the hub one included", () => {
    const text = source(CARD);
    // "▶ hub" is deliberately ungated by the agent-prompt blocker (it
    // builds no argv), so it has to be gated separately here -- and it is
    // the one that pastes the card's body into a live agent.
    expect(text).toContain("disabled={runBlocked !== null || developBlock !== null}");
    expect(text).toContain("disabled={!agentAvailable || developBlock !== null}");
    expect(text).toContain("if (agentAvailable && developBlock === null) onSendToAgent?.(card)");
  });

  it("hangs the reason on the ROW, which is never disabled", () => {
    // The trap tooltip.ts documents: a disabled element fires no
    // mouseenter, so a tooltip bound to one can never open. A dead button
    // with no reason is exactly the state this card complained about.
    expect(source(CARD)).toContain('class="run-pills" use:tooltip={developBlock ?? runBlocked}');
  });
});

describe("the card menu", () => {
  it("replaces every run entry with the jump, ahead of every other case", () => {
    const text = source(MENU);
    expect(text).toContain("if (developingRunOn(workspaceId, card.id)) {");
    expect(text).toContain("label: DEVELOPING_MENU_LABEL");
    // Ahead of the best-of-N branch, which is the other "a run is in
    // flight" case: both replace the run block rather than adding to it.
    expect(text.indexOf("developingRunOn(workspaceId, card.id)")).toBeLessThan(
      text.indexOf("Best of ${run.candidates.length}")
    );
  });
});

describe("the card detail modal", () => {
  it("replaces the unbound block with the develop note and one jump", () => {
    const text = source(DETAIL);
    // The launch buttons now live in the pinned session bar, so the
    // branch that replaces them is the SITUATION the bar is built from
    // -- cardSituation's precedence, where it is unit-tested. The panel
    // has to feed it the fact and read the answer, not re-decide it.
    expect(text).toContain("developing: developing !== null,");
    // cardSituation's BODY: the type above it declares the same arms in
    // reading order rather than precedence order.
    const module = source("cardDetail.ts");
    const fn = module.slice(module.indexOf("export function cardSituation("));
    expect(fn.indexOf('{ kind: "developing" }')).toBeLessThan(fn.indexOf('kind: "unbound"'));
    // And the note itself, which is what the bar has no room for.
    expect(text).toContain("{:else if developing}");
    expect(text).toContain("An agent is developing this card");
  });

  it("gives a developing card exactly one action, and it is the jump", () => {
    // The bar's own rule, where every other surface's refusal ends up:
    // nothing may run a card whose file is being rewritten.
    const bar = cardSessionBar({ kind: "developing" });
    expect(bar?.actions.map((a) => a.id)).toEqual(["develop-jump"]);
    expect(bar?.actions[0].label).toBe("Jump to the develop session");
  });
});

describe("the column's run button", () => {
  it("counts a developing card out of its targets", () => {
    // The launch would refuse it anyway; the count is the point, or
    // "Start all (7 unbound)" starts six.
    expect(source(COLUMN)).toContain("developingRunIn($layoutState, workspaceId, path) !== null");
  });
});
