import { describe, it, expect } from "vitest";

// Auto commit is one setting expressed on four surfaces -- the ⌘N
// composer, the card detail modal, the workspace settings panel and the
// app-wide one -- and nothing links those four files. Every rule they
// share is therefore invisible to every other suite: a panel whose select
// is wired to no setter renders perfectly, and a composer that offers the
// box on the note chip type-checks fine. Both are dead controls, which is
// the failure this pins.
//
// Reads the component sources rather than the rendered DOM, following
// hubTabBar.test.ts: mounting four modals to assert "this handler is
// called" tests the harness, and a component `<style>` is compiled away
// anyway.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const COMPOSER = "CardComposeModal.svelte";
const DETAIL = "CardDetailModal.svelte";
const WORKSPACE_PANEL = "SettingsHubView.svelte";
const APP_PANEL = "GlobalSettingsModal.svelte";

describe("the composer", () => {
  it("offers the box only where the kind can carry it", () => {
    // Not `kind !== "note"` spelled out again here: the rule lives in
    // autoCommit.ts, and a second copy is a second thing to update.
    expect(source(COMPOSER)).toContain("{#if autoCommitAppliesTo(kind)}");
  });

  it("hands the flag to the pure builder, so the card reaches disk complete", () => {
    // One CreatePlan. A card written first and enriched second has a
    // window in which it exists without the instruction, and a failure
    // mode in which it never gets it.
    expect(source(COMPOSER)).toContain("attachments, autoCommit }");
  });

  it("seeds the box from the resolved default rather than a literal", () => {
    const text = source(COMPOSER);
    expect(text).toContain("get(newCardAutoCommit)");
    // `get`, not `$newCardAutoCommit`: a subscription would let a
    // settings change flip a box the human has already ticked.
    expect(text).not.toContain("$newCardAutoCommit");
  });
});

describe("the card detail modal", () => {
  it("offers the row only where the kind can carry it", () => {
    expect(source(DETAIL)).toContain("{#if autoCommitApplies}");
    expect(source(DETAIL)).toContain("autoCommitAppliesTo(card.kind)");
  });

  it("writes the FILE, because the state is in the body", () => {
    const text = source(DETAIL);
    expect(text).toContain("setAutoCommitInFile");
    expect(text).toContain("backend.writeFileForEditor");
    // setPlanFrontmatterField cannot reach a card's body, so a toggle
    // routed through writeField would silently do nothing.
    expect(text).not.toContain('writeField("autoCommit"');
  });

  it("re-reads before it splices, so it cannot undo an agent's edit", () => {
    // `content` is a watched snapshot behind a debounce, and this write
    // replaces the whole file.
    const toggle = /async function toggleAutoCommit[\s\S]*?\n  }\n/.exec(source(DETAIL));
    expect(toggle).not.toBeNull();
    const body = toggle![0];
    expect(body.indexOf("readFileForViewer")).toBeGreaterThan(-1);
    expect(body.indexOf("readFileForViewer")).toBeLessThan(body.indexOf("setAutoCommitInFile"));
  });
});

describe("both settings panels", () => {
  it("render the rows from the shared vocabulary, not their own literals", () => {
    // Two hand-written option lists are how "Default (off)" ends up
    // saying one thing on one panel and another on the other.
    expect(source(WORKSPACE_PANEL)).toContain("autoCommitOptions(inheritedAutoCommit)");
    expect(source(APP_PANEL)).toContain("autoCommitOptions(DEFAULT_AUTO_COMMIT)");
  });

  it("are each wired to a real setter", () => {
    expect(source(WORKSPACE_PANEL)).toContain("setWorkspaceAutoCommit(workspaceId");
    expect(source(APP_PANEL)).toContain("setAutoCommitDefault(autoCommitFromSelect");
  });

  it("read their current value back, so a reopened panel shows what is stored", () => {
    expect(source(WORKSPACE_PANEL)).toContain("autoCommitToSelect(ws.autoCommit)");
    expect(source(APP_PANEL)).toContain("autoCommitToSelect($autoCommitDefault)");
  });

  it("label the section the same on both, so they read as one setting", () => {
    for (const panel of [WORKSPACE_PANEL, APP_PANEL]) {
      expect(source(panel)).toContain("<h3>Cards</h3>");
      expect(source(panel)).toContain("<span>Auto commit</span>");
    }
  });
});
