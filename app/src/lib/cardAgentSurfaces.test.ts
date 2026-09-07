import { describe, it, expect } from "vitest";

// A card's own `agent:`/`model:` is one field pair expressed on four
// surfaces -- the shared controls, the card detail modal, the Plans tab's
// metadata strip and the board card's glyph -- plus the launch route that
// has to honour it. Nothing links those files, and every rule they share
// is invisible to every other suite: a select wired to no setter renders
// perfectly, and a compat gate with no consumer type-checks fine. Both
// are dead controls, which is the failure this pins.
//
// Reads the component sources rather than the rendered DOM, following
// complexitySurfaces.test.ts: mounting four components to assert "this
// handler is called" tests the harness, and a component `<style>` is
// compiled away anyway.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TS_SOURCES = import.meta.glob("./*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`] ?? TS_SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const CONTROLS = "CardAgentControls.svelte";
const DETAIL = "CardDetailModal.svelte";
const PLANS_PANEL = "PlanMetadataPanel.svelte";
const BOARD_CARD = "BoardCard.svelte";
const LAYOUT = "layoutState.ts";

describe("the card surfaces", () => {
  it.each([
    ["the detail modal", DETAIL],
    ["the Plans tab strip", PLANS_PANEL],
  ])("%s renders the shared controls rather than its own", (_name, file) => {
    // Two copies of a profile select and a model picker is how the two
    // surfaces start describing different things -- the same reason
    // ComplexityTable.svelte serves both settings panels.
    expect(source(file)).toContain("<CardAgentControls");
    expect(source(file)).toContain('import CardAgentControls from "./CardAgentControls.svelte"');
  });

  it.each([
    ["the detail modal", DETAIL],
    ["the Plans tab strip", PLANS_PANEL],
  ])("%s gates on the daemon version rather than failing on change", (_name, file) => {
    // A v31 daemon fails this in BOTH directions: it refuses the two
    // set_plan_field keys, and it never parses the two lines either, so
    // a card that already carries an override reads back as carrying
    // none. min_version_for adds no request variant to see, so
    // FEATURE_MIN_VERSION.cardAgent is the only gate there is.
    expect(source(file)).toContain('featureBlockedReason($daemonCompat, "cardAgent")');
    expect(source(file)).toContain("cardAgentBlocked");
  });

  it("offers inherit as the absence of the line, not the current profile", () => {
    // NO_CARD_AGENT, never a literal "" and never the workspace's
    // profile id: clearing means the card FOLLOWS the workspace, and
    // naming today's profile would pin the card to it the moment the
    // workspace moved.
    expect(source(CONTROLS)).toContain("<option value={NO_CARD_AGENT}>inherit</option>");
  });

  it("offers the presets AND a typed value for the model", () => {
    // Both halves of the ask: pick a default option, or set a custom
    // one. `modelChoices` is the shared row builder, CUSTOM_MODEL the
    // sentinel that reveals the box.
    expect(source(CONTROLS)).toContain("modelChoices(");
    expect(source(CONTROLS)).toContain("CUSTOM_MODEL");
    expect(source(CONTROLS)).toContain("modelIsCustom");
  });

  it("builds the model presets from the profile the card RESOLVES to", () => {
    // Not the workspace's profile: a card that names codex has to offer
    // codex's models, and a card that names none has to offer whatever
    // its level or the workspace lands on.
    expect(source(CONTROLS)).toContain("$cardAgents(workspaceId, card)");
    expect(source(CONTROLS)).toContain("resolvedProfile?.models ?? []");
  });

  it("says what the card will actually launch, and which control won", () => {
    // The whole reason the pair exists. A card can carry a level AND an
    // override, and the two controls sit next to each other showing
    // different answers -- so the line has to name the winner.
    expect(source(DETAIL)).toContain("cardAgentSummary(");
    expect(source(DETAIL)).toContain("cardAgentLine");
  });

  it("marks a card that runs somewhere its column does not explain", () => {
    expect(source(BOARD_CARD)).toContain("agentOverride");
  });
});

describe("the launch", () => {
  it("resolves every card through one path, override or not", () => {
    // `agentForCard` is called unconditionally by board Run, the rail's
    // card step, both resumes and a re-launch. Routing it through
    // `cardAgentEntry` is what makes the override reach all five without
    // a second resolution path per route -- and what keeps a card with
    // no override behaving exactly as it did before.
    expect(source(LAYOUT)).toContain("cardAgentEntry(");
    expect(source(LAYOUT)).toContain("agentConfigWithAttribution(");
  });

  it("gives components a reactive resolver, not the one-shot one", () => {
    // The profile table is fetched asynchronously at bootstrap, so a
    // modal derived from `agentForCard` would show claude-code's answer
    // for the life of the modal.
    expect(source(LAYOUT)).toContain("export const cardAgents = derived(");
  });
});
