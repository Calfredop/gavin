// The hub on a phone on its side: nothing under the Dynamic Island or the
// rounded corners.
//
// Turned sideways an iPhone 16 Pro insets 62px each side. The hub keeps
// clear of them as the bundle's page does (the bundle's
// seam/landscape.test.ts): once, on its frame, with nothing inside
// reading a side inset again, and every layer fixed over it -- the
// pairing sheet -- keeping clear itself.
import { describe, expect, it } from "vitest";
import { componentRules, padsBothSides, readsSideInset } from "$companion/testing/safeArea";
import { drawnComponents } from "$companion/testing/textColours";

const OWN = import.meta.glob(["../**/*.svelte", "../../routes/**/*.svelte"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/// The hub's own components, and the bundle's header it borrows.
const HEADER = import.meta.glob("../../../../companion/src/companion/surfaces/PhoneHeader.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RULES = componentRules(drawnComponents({ ...OWN, ...HEADER }));
const frame = RULES.find((rule) => rule.file.endsWith("/Hub.svelte") && rule.selectors.includes(".hub"));

describe("the hub's side insets", () => {
  it("are the hub frame's, both sides", () => {
    expect(frame).toBeDefined();
    expect(frame && padsBothSides(frame)).toBe(true);
  });

  it("are read by nothing inside the frame but a layer fixed over it, which keeps clear itself", () => {
    // The globs finding the hub and the header at all.
    expect(RULES.some((rule) => rule.file.endsWith("/PhoneHeader.svelte"))).toBe(true);
    const fixed = RULES.filter((rule) => rule.declarations.get("position") === "fixed");
    expect(fixed.some((rule) => rule.file.endsWith("/PairingSheet.svelte"))).toBe(true);

    const again = RULES.filter((rule) => readsSideInset(rule) && rule !== frame && !fixed.includes(rule));
    expect(again.map((rule) => `${rule.file} ${rule.selectors.join(", ")}`)).toEqual([]);
    expect(fixed.filter((rule) => !padsBothSides(rule)).map((rule) => rule.file)).toEqual([]);
  });
});
