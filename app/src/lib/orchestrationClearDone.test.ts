import { describe, it, expect } from "vitest";

// The toolbar's "Clear done" -- the one press on this tab that removes
// several rails at once -- lives in the hub view's template and one
// handler, neither of which the pure suite can reach. Four facts about
// it are worth pinning, because every one of them fails silently:
//
//   * WHERE it sits. The card asked for it beside "Run all", and a
//     toolbar reorder elsewhere in the header would move it without a
//     test going red.
//   * WHAT gates it. Anything but finishedRails' own answer -- a raw
//     rails.length, the done-column name -- would offer a press that
//     removes the wrong rails or none.
//   * That it ASKS first, in the app's own ConfirmPrompt (there are no
//     native dialogs here) and with the danger tone, since nothing it
//     removes comes back.
//   * That it removes them in ONE write, from ids read before the
//     prompt closes. `finished` is derived: it empties the instant the
//     rails leave the plan, so reading it after would remove nothing.
//
// Reads the component source rather than the rendered DOM, following
// orchestrationRunAll.test.ts.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const HUB = SOURCES["./OrchestrationHubView.svelte"];

describe("the Clear done button", () => {
  it("sits in the toolbar between Run all and New rail", () => {
    const runAll = HUB.indexOf("<Play size={14} /> Run all");
    const clearDone = HUB.indexOf("<BrushCleaning size={14} /> Clear done");
    const newRail = HUB.indexOf("<Plus size={14} /> Rail");
    expect(clearDone).toBeGreaterThan(runAll);
    expect(clearDone).toBeLessThan(newRail);
  });

  it("is dead exactly when no rail has finished everything on it", () => {
    expect(HUB).toContain("disabled={finished.length === 0}");
    expect(HUB).toContain("const finished = $derived(orch ? finishedRails(orch) : [])");
  });

  it("asks first, through the app's own ConfirmPrompt, in the danger tone", () => {
    expect(HUB).toContain("clearFinishedPrompt = true");
    expect(HUB).toContain("title={clearFinishedContent.title}");
    expect(HUB).toContain("label: clearFinishedContent.confirmLabel");
    const prompt = HUB.slice(HUB.indexOf("{#if clearFinishedContent}"));
    expect(prompt.slice(0, prompt.indexOf("{/if}"))).toContain("danger: true");
  });
});

describe("clearing every finished rail", () => {
  const body = HUB.slice(
    HUB.indexOf("function clearFinished()"),
    HUB.indexOf("function clearFinished()") + 300
  );

  it("takes the rail ids before the prompt closes", () => {
    expect(body).toContain("const ids = finished.map((r) => r.id);");
    expect(body.indexOf("const ids")).toBeLessThan(body.indexOf("clearFinishedPrompt = false"));
  });

  it("removes them in one plan write, never a rail at a time", () => {
    expect(body).toContain("deleteRailsAction(workspaceId, ids)");
    expect(body).not.toContain("deleteRailAction(");
  });
});
