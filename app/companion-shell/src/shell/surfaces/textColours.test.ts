// The hub paints its text in theme.css's text roles and nothing else.
//
// The bundle's seam/themeContrast.test.ts holds every text role at 4.5:1
// on every surface of both themes; a colour outside those roles is one
// nobody measured. The hub's "Waiting on you" label was `--accent`, a
// fill, which is 2.75:1 on white: it measured clean on an iPhone only
// because nothing was waiting at the time.
import { describe, expect, it } from "vitest";
import { drawnComponents, untextedColours } from "$companion/testing/textColours";

const OWN = import.meta.glob(["../**/*.svelte", "../../routes/**/*.svelte"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the hub's text", () => {
  it("is painted in text roles, in its own components and every desktop one they draw", () => {
    // The glob finding the hub at all, or a sweep over nothing passes.
    expect(Object.keys(OWN).some((path) => path.endsWith("/Hub.svelte"))).toBe(true);
    expect(untextedColours(drawnComponents(OWN))).toEqual([]);
  });
});
