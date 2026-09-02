import { describe, it, expect } from "vitest";

// "Run all" lives entirely in the hub view's template and one async
// function, and neither is reachable from the pure suite. Three facts
// about it are worth pinning, because all three are silent when they
// break:
//
//   * WHERE the button sits. The card asked for it before "New rail",
//     and a toolbar reorder somewhere else in the header would move it
//     without a single test going red.
//   * WHAT gates it. Anything other than runnableIdleRails' own answer
//     (agentAvailable, a raw rails.length) would offer a press that
//     starts nothing.
//   * That the starts are SEQUENTIAL. Every run-state write reads the
//     store, applies to that snapshot and writes it all back, so a
//     Promise.all here would have each start build on the same railRuns
//     and the last one win -- rails that look idle while their steps
//     launch. It type-checks, it is faster, and it is wrong.
//
// Reads the component source rather than the rendered DOM, following
// orchestrationGroupLabel.test.ts.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const HUB = SOURCES["./OrchestrationHubView.svelte"];

describe("the Run all button", () => {
  it("sits in the toolbar before the New rail button", () => {
    const runAll = HUB.indexOf("<Play size={14} /> Run all");
    const newRail = HUB.indexOf("<Plus size={14} /> Rail");
    expect(runAll).toBeGreaterThan(-1);
    expect(newRail).toBeGreaterThan(-1);
    expect(runAll).toBeLessThan(newRail);
  });

  it("is dead exactly when no idle rail has anything to run", () => {
    expect(HUB).toContain("disabled={runnableRails.length === 0}");
    expect(HUB).toContain("const runnableRails = $derived(orch ? runnableIdleRails(orch) : [])");
  });

  it("asks first, through the app's own ConfirmPrompt", () => {
    expect(HUB).toContain("runAllPrompt = true");
    expect(HUB).toContain("title={runAllContent.title}");
    expect(HUB).toContain("label: runAllContent.confirmLabel");
  });
});

describe("running every idle rail", () => {
  const body = HUB.slice(HUB.indexOf("async function runAll()"), HUB.indexOf("async function runAll()") + 400);

  it("awaits each start in turn", () => {
    expect(body).toContain("for (const id of ids) await startRail(workspaceId, id);");
  });

  it("never fans the starts out in parallel", () => {
    expect(body).not.toContain("Promise.all");
  });

  it("takes the rail ids before the first await, not from the derived mid-loop", () => {
    // runnableRails is derived: the first rail leaves it the moment it is
    // armed, so iterating it directly would skip every other rail.
    expect(body).toContain("const ids = runnableRails.map((r) => r.id);");
  });
});
