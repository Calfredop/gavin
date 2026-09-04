import { describe, it, expect } from "vitest";

// The completion cascade only works if EVERY human gesture that can file
// a plan goes through it. Nothing links those call sites -- three of them
// are `.ts` modules, one is a component, and each writes `status:` with
// its own two lines of backend call -- so a new one added tomorrow, or an
// old one quietly rewritten, would restore exactly the silence
// cardCompletion.ts exists to end, with every suite still green.
//
// Reads the sources rather than mounting anything, following
// autoCommitSurfaces.test.ts: the failure being pinned is a MISSING call,
// which no rendered DOM can show.

const TS = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const SVELTE = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = TS[`./${name}`] ?? SVELTE[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("every gesture that can file a plan asks first", () => {
  it.each([
    ["planDrop.ts", "the board's drag"],
    ["cardMenu.ts", "the card menu's Move to"],
    ["CardDetailModal.svelte", "the detail modal's status select"],
    ["orchestrationState.ts", "the rail header's Move all to"],
    ["PlanMetadataPanel.svelte", "the Plans tab's metadata panel"],
  ])("%s — %s", (file) => {
    expect(source(file)).toContain("guardCompletion(");
  });

  // The one status write left unguarded on purpose: relocating a deleted
  // column's cards already raises a prompt of its own, and a second
  // dialog stacked on the first is how a human learns to dismiss both.
  it("the column-delete prompt says it in a line instead of a second dialog", () => {
    expect(source("cardDelete.ts")).not.toContain("guardCompletion(");
    expect(source("KanbanColumn.svelte")).toContain("travellingChildren");
  });

  // Adopting a memory files a `kind: note` card, and only a plan can be
  // a parent -- so there is never anything to carry. Named here so the
  // omission reads as decided rather than missed.
  it("adopting a memory needs no guard: a note has no children", () => {
    expect(source("memoryCard.ts")).not.toContain("guardCompletion(");
  });
});

describe("the escape is offered where the human can see the children", () => {
  it("the detail modal's Tasks list breaks a nested child out", () => {
    const modal = source("CardDetailModal.svelte");
    expect(modal).toContain("Break out");
    // Kept apart from "Un-parent" beside it: one keeps the link to the
    // plan, the other throws it away, and a row offering both has to be
    // able to say which is which.
    expect(modal).toContain("breakOutChildren(");
    expect(modal).toContain("Un-parent");
  });

  it("the nested-with-parent conflict repairs rather than only complaining", () => {
    expect(source("OrchestrationConflicts.svelte")).toContain(
      'conflict.kind === "nested-with-parent"'
    );
    expect(source("OrchestrationHubView.svelte")).toContain("breakOutNestedCardAction(");
  });
});
