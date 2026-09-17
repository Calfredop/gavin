import { describe, it, expect } from "vitest";

import { source } from "$lib/sources";

// The ladder is drawn by a component no unit suite can mount -- the
// modal needs a window -- so what a guard can still see is the wiring:
// a picker that reaches the markup, a chosen rung that reaches
// answerDialog, and a destructive rung that reaches the button.
const PROMPT = source("ConfirmPrompt.svelte");
const DIALOG = source("AppDialog.svelte");

describe("the confirm prompt's ladder", () => {
  // Radios, not a <select>: three of the close prompt's four answers
  // would otherwise be invisible until clicked, and answers that were
  // never on screen cannot be claimed to have been read.
  it("draws an expanded picker as radios", () => {
    expect(PROMPT).toContain("picker.expanded");
    expect(PROMPT).toContain('type="radio"');
  });

  // Where a ladder starts is the data's decision (appClose.ts opens on
  // the harmless rung), not the component's "first option wins".
  it("opens on the picker's own default", () => {
    expect(PROMPT).toContain("picker.default ??");
  });

  // Enter must not fire a rung that ends a day's agents. `danger` is a
  // property of the RUNG, so one prompt can be safe to answer by reflex
  // at the top of its ladder and not at the bottom.
  it("takes danger from the picked rung", () => {
    expect(PROMPT).toContain("pickedOption?.danger");
  });
});

describe("AppDialog", () => {
  it("hands the picker down and the chosen rung back", () => {
    expect(DIALOG).toContain("picker={req.picker}");
    expect(DIALOG).toContain("answerDialog(req.id, true, checked, picked)");
  });
});
