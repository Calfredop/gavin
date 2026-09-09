import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The toolbar's "Clear" -- a dropdown over the two ways to remove every
// rail that has finished everything on it -- lives in the hub view's
// template and one handler, neither of which the pure suite can reach.
// Facts about it worth pinning, because every one of them fails silently:
//
//   * WHERE it sits. The card asked for it beside "Run all", and a
//     toolbar reorder elsewhere in the header would move it without a
//     test going red.
//   * WHAT gates it. Anything but finishedRails' own answer -- a raw
//     rails.length, the done-column name -- would offer a press that
//     removes the wrong rails or none.
//   * That it offers exactly the two options the card asked for --
//     "Clear done" and "Clear and archive done" -- through the app's own
//     dropdown menu, not a native <select> (there are no native dialogs
//     here).
//   * That either option ASKS first, in the app's own ConfirmPrompt, and
//     with the danger tone, since nothing it removes comes back.
//   * That it removes the rails in ONE write, from ids read before the
//     prompt closes. `finished` is derived: it empties the instant the
//     rails leave the plan, so reading it after would remove nothing.
//   * That only the archive mode ever calls executeArchive, and only on
//     cards the board already calls Done.
//
// Reads the component source rather than the rendered DOM, following
// orchestrationRunAll.test.ts.

const SOURCES = svelteSources();

const HUB = SOURCES["OrchestrationHubView.svelte"];

describe("the Clear dropdown button", () => {
  it("sits in the toolbar between Run all and New rail", () => {
    const runAll = HUB.indexOf("<Play size={14} /> Run all");
    const clearButton = HUB.indexOf("<BrushCleaning size={14} /> Clear");
    const newRail = HUB.indexOf("<Plus size={14} /> Rail");
    expect(clearButton).toBeGreaterThan(runAll);
    expect(clearButton).toBeLessThan(newRail);
  });

  it("is dead exactly when no rail has finished everything on it", () => {
    expect(HUB).toContain("disabled={finished.length === 0}");
    expect(HUB).toContain("const finished = $derived(orch ? finishedRails(orch) : [])");
  });

  it("opens a menu with both options rather than acting directly", () => {
    const opener = HUB.slice(
      HUB.indexOf("function openClearMenu"),
      HUB.indexOf("function openClearMenu") + 400
    );
    expect(opener).toContain("openMenuUnder(");
    expect(opener).toContain('label: "Clear done"');
    expect(opener).toContain('clearFinishedPrompt = "clear"');
    expect(opener).toContain('label: "Clear and archive done"');
    expect(opener).toContain('clearFinishedPrompt = "archive"');
  });

  it("asks first, through the app's own ConfirmPrompt, in the danger tone, whichever option was picked", () => {
    expect(HUB).toContain("title={clearFinishedContent.title}");
    expect(HUB).toContain("label: clearFinishedContent.confirmLabel");
    const prompt = HUB.slice(HUB.indexOf("{#if clearFinishedContent}"));
    expect(prompt.slice(0, prompt.indexOf("{/if}"))).toContain("danger: true");
  });
});

describe("clearing every finished rail", () => {
  const body = HUB.slice(
    HUB.indexOf("async function clearFinished()"),
    HUB.indexOf("async function clearFinished()") + 700
  );

  it("takes the rail ids and the mode before the prompt closes", () => {
    expect(body).toContain('const archiving = clearFinishedPrompt === "archive";');
    expect(body).toContain("const targets = finished;");
    expect(body).toContain("const ids = targets.map((r) => r.id);");
    expect(body.indexOf("const ids")).toBeLessThan(body.indexOf("clearFinishedPrompt = null"));
  });

  it("removes the rails in one plan write, never a rail at a time", () => {
    expect(body).toContain("deleteRailsAction(workspaceId, ids)");
    expect(body).not.toContain("deleteRailAction(");
  });

  it("only archives in archive mode, and only cards the board calls Done", () => {
    expect(body).toContain("const cardViews = archiving");
    expect(body).toContain("executeArchive(workspaceId, cardViews)");
    expect(body).toContain("slugStatus(v.status) === slugStatus(doneName)");
  });
});
