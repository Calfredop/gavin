// The hub's spacing is one scale: phone.css's `--space-*`, in 8px steps.
//
// On a physical iPhone 16 Pro the owner found the hub's spacing poor.
// Measured, it was nine numbers and no scale: rows padded 14px against a
// 16px gutter for Pair and the notes and 12px for the header, a section
// heading 18px over its rows and 6px under, the keys panel 20 over 24,
// and every row of the inbox and the Workstations flush against the
// next, a hairline between two tap targets.
import { describe, expect, it } from "vitest";
import { componentRules } from "$companion/testing/safeArea";

const OWN = import.meta.glob(["./Hub.svelte", "./InboxList.svelte", "./InboxItem.svelte", "./KeysPanel.svelte"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PHONE_CSS = Object.values(
  import.meta.glob("../../../../companion/src/companion/surfaces/phone.css", { query: "?raw", import: "default", eager: true })
)[0] as string;

const SPACING = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/;

/// The bundle's tag beside a demo's name, copied as it is drawn there.
const OWN_SIZE = new Set([".tag"]);

/// Whether one value of a spacing declaration is on the scale: none,
/// `auto`, a step, a safe-area inset, or a sum of those.
function onScale(value: string): boolean {
  if (value === "0" || value === "auto") return true;
  if (/^var\(--space-(half|\d)\)$/.test(value)) return true;
  if (/^env\(safe-area-inset-[a-z]+(, 0px)?\)$/.test(value)) return true;
  const sum = /^calc\((.*)\)$/.exec(value);
  if (sum) {
    return sum[1]
      .replace(/var\(--space-(half|\d)\)/g, "")
      .replace(/env\(safe-area-inset-[a-z]+(, 0px)?\)/g, "")
      .replace(/[+\s]/g, "") === "";
  }
  return false;
}

/// A shorthand's values, split where they are not inside brackets.
function values(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === " " && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

const RULES = componentRules(OWN);

describe("the hub's spacing", () => {
  it("is phone.css's scale, in 8px steps", () => {
    const steps = Object.fromEntries([...PHONE_CSS.matchAll(/--space-(half|\d): (\d+)px;/g)].map((m) => [m[1], Number(m[2])]));
    expect(steps).toEqual({ half: 4, "1": 8, "2": 16, "3": 24, "4": 32 });
  });

  it("is drawn from the scale and nothing else, in every component of the hub's", () => {
    // The glob finding the components at all, or a sweep over nothing passes.
    expect(Object.keys(OWN)).toHaveLength(4);
    const off = RULES.filter((rule) => !rule.selectors.every((s) => OWN_SIZE.has(s))).flatMap((rule) =>
      [...rule.declarations]
        .filter(([property, value]) => SPACING.test(property) && !values(value).every(onScale))
        .map(([property, value]) => `${rule.file} ${rule.selectors.join(", ")} { ${property}: ${value} }`)
    );
    expect(off).toEqual([]);
  });

  it("keeps a step between any two tap targets, side by side or one over the other", () => {
    // Every container that holds more than one target, and the space it
    // keeps between them.
    const between: Array<[string, string, string]> = [
      ["/Hub.svelte", ".section", "gap"],
      ["/Hub.svelte", ".cards", "gap"],
      ["/Hub.svelte", ".unlock", "gap"],
      ["/Hub.svelte", ".note", "gap"],
      ["/InboxList.svelte", ".filters", "gap"],
      ["/InboxList.svelte", ".slot-item", "padding-bottom"],
      ["/KeysPanel.svelte", ".actions", "gap"],
    ];
    for (const [file, selector, property] of between) {
      const rule = RULES.find((r) => r.file.endsWith(file) && r.selectors.includes(selector));
      const value = rule?.declarations.get(property);
      expect(value, `${file} ${selector} ${property}`).toMatch(/^var\(--space-[1-4]\)$/);
    }
  });
});
