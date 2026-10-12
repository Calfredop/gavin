// The hub follows the phone's text size, as the bundle does.
//
// On an iPhone 16 Pro at the largest accessibility text size the hub's
// title stayed 13px and its captions 9.75px. The hub draws on the
// bundle's page rules (phone.css), whose root is 16px times the
// `--text-scale` that `$companion/surfaces/textScale.ts` keeps; the
// bundle's seam/textScale.test.ts holds those. What is the hub's own: its
// layout starts the following, and nothing it draws is sized in px.
import { describe, expect, it } from "vitest";
import { drawnComponents } from "$companion/testing/textColours";
import { fixedSizes } from "$companion/testing/textSizes";

const OWN = import.meta.glob(["../**/*.svelte", "../../routes/**/*.svelte"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function own(name: string): string {
  const found = Object.entries(OWN).find(([path]) => path.endsWith(name));
  if (!found) throw new Error(`the shell has no ${name}`);
  return found[1];
}

describe("the hub's text", () => {
  it("follows the phone's text size from the moment the page mounts", () => {
    const layout = own("routes/+layout.svelte");
    expect(layout).toContain('import "$companion/surfaces/phone.css";');
    expect(layout).toMatch(/onMount\(\(\) => followTextScale\(\)\)/);
  });

  it("is sized against the root, in its own components and every desktop one they draw", () => {
    // The glob finding the hub at all, or a sweep over nothing passes.
    expect(Object.keys(OWN).some((path) => path.endsWith("/Hub.svelte"))).toBe(true);
    expect(fixedSizes(drawnComponents(OWN))).toEqual([]);
  });
});
