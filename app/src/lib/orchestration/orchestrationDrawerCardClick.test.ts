import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// A press on an unplaced card row used to append that card to the FIRST
// rail -- an arbitrary target the row never named, reached by the one
// gesture a human uses to READ something. The row is a card, and the
// tab already owns the board's detail modal for exactly this (see
// `openCardPath`), so the press now opens the card.
//
// Placement keeps both of its deliberate gestures: drag the row onto the
// rail you mean, or use that rail's own "+ Add step". Tool and template
// rows are unaffected -- neither is a card, neither has a modal to open,
// and click-to-append is the only thing a press on one could mean.
//
// A rendered tab is out of a unit test's reach, so this pins the
// template's shape the way orchestrationDrawerNoRails.test.ts does.

const SVELTE = svelteSources();

/// A component's source with its comments stripped -- `//` lines in the
/// script and `<!-- -->` blocks in the template -- so an assertion about
/// what the TEMPLATE does is not satisfied (or broken) by prose that
/// merely names the same string.
function codeOf(name: string): string {
  const text = SVELTE[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("///"))
    .join("\n");
}

describe("pressing an unplaced card row opens its detail modal", () => {
  const drawer = codeOf("OrchestrationDrawer.svelte");
  const hub = codeOf("OrchestrationHubView.svelte");

  it("routes the card row's click to onOpenCard", () => {
    expect(drawer).toMatch(/onclick=\{\(\) => onOpenCard\(entry\.plan\.path\)\}/);
  });

  it("has no placement callback left for a card row to call", () => {
    // The prop is gone rather than merely unused: an `onAdd` still in
    // the surface is an invitation to wire the old press back.
    expect(drawer).not.toMatch(/\bonAdd\b/);
    expect(hub).not.toMatch(/\bonAdd=/);
  });

  it("keeps click-to-append on the tool and template rows", () => {
    expect(drawer).toMatch(/onclick=\{\(\) => onAddTool\(tool\.id\)\}/);
    expect(drawer).toMatch(/onclick=\{\(\) => onAddTemplate\(t\.id\)\}/);
  });

  it("leaves a card row live with no rail, though still without a drag handle", () => {
    // Reading a card needs no rail. Placing one does, so the drag
    // attribute stays gated -- the glue takes any row wearing it as a
    // drag subject, disabled or not.
    expect(drawer).toMatch(/data-orch-card=\{targetRailId \? entry\.plan\.path : undefined\}/);
    const rowAt = drawer.indexOf("data-orch-card=");
    const row = drawer.slice(rowAt, drawer.indexOf("</button>", rowAt));
    expect(row).not.toContain("disabled");
    // The rows that DO need a rail keep saying so.
    // `blocked`, not `toolsBlocked`: the tool row folds the daemon gate
    // and a tool this machine cannot run at all into one reason.
    expect(drawer).toMatch(/disabled=\{Boolean\(blocked\) \|\| !targetRailId\}/);
    expect(drawer).toMatch(/disabled=\{Boolean\(groupsBlocked\) \|\| !targetRailId\}/);
  });

  it("hands the drawer the same card-detail state the rails' chips open", () => {
    // One modal for the tab: a drawer card and a placed step chip must
    // land on the same `openCardPath`, or the two would drift into two
    // different readings of the same card.
    const drawerAt = hub.indexOf("<OrchestrationDrawer");
    expect(drawerAt).toBeGreaterThan(0);
    const el = hub.slice(drawerAt, hub.indexOf("/>", drawerAt));
    expect(el).toMatch(/onOpenCard=\{\(path\) => \(openCardPath = path\)\}/);
  });

  it("says what a press does now, so the hint does not promise the old append", () => {
    expect(drawer).not.toContain("click to append it");
    expect(drawer).toContain("Click a card to open it");
  });
});
