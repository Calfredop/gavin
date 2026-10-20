// The hub selects what is read and nothing that is pressed, as the bundle
// does (its seam/selection.test.ts, which holds phone.css's three rules).
//
// A press held a moment too long on a Workstation card, a filter or the
// Unlock banner started a text selection and the iOS callout instead of
// the press. The hub loads phone.css, whose page turns selection off; the
// pairing code, an error line and the keys panel's readout opt back in.
import { describe, expect, it } from "vitest";
import { drawnElements, isNamed, isReadable, nameOf, unpairedSelects } from "$companion/testing/selection";

const OWN = import.meta.glob(["../**/*.svelte", "../../routes/**/*.svelte"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PHONE_CSS = Object.values(
  import.meta.glob("../../../../companion/src/companion/surfaces/phone.css", { query: "?raw", import: "default", eager: true })
)[0] as string;

const LAYOUT = Object.values(
  import.meta.glob("../../routes/+layout.svelte", { query: "?raw", import: "default", eager: true })
)[0] as string;

const DRAWN = drawnElements(OWN, PHONE_CSS);

/// Text the sweep's markers do not find, that is there to read or copy.
const READ = ["./PairingSheet.svelte p.code", "./KeysPanel.svelte p.line"];

/// What a thumb presses, named so that the sweep sees it at all.
const PRESSED = [
  "./Hub.svelte button.card",
  "./Hub.svelte button.action",
  "./InboxItem.svelte button.item",
  "./InboxList.svelte button.filter",
  "./KeysPanel.svelte summary",
];

describe("the hub's selection", () => {
  it("is phone.css's, which the hub loads", () => {
    expect(LAYOUT).toContain('import "$companion/surfaces/phone.css";');
    expect(PHONE_CSS).toMatch(/\bhtml \{[^}]*-webkit-user-select: none;/);
  });

  it("selects every error line the hub draws", () => {
    // The glob finding the hub at all, or a sweep over nothing passes.
    expect(Object.keys(OWN).some((path) => path.endsWith("/Hub.svelte"))).toBe(true);
    const readable = DRAWN.filter((el) => isReadable(el) && !el.pressed);
    expect(readable.length).toBeGreaterThan(2);
    expect(readable.filter((el) => !el.selectable).map(nameOf)).toEqual([]);
  });

  it("selects the pairing code and the keys panel's readout", () => {
    for (const name of READ) {
      const found = DRAWN.filter((el) => isNamed(el, name));
      expect(found.length, name).toBeGreaterThan(0);
      expect(found.filter((el) => !el.selectable).map(nameOf), name).toEqual([]);
    }
  });

  it("selects nothing a person presses", () => {
    const pressed = DRAWN.filter((el) => el.pressed);
    for (const name of PRESSED) expect(pressed.some((el) => isNamed(el, name)), name).toBe(true);
    expect(pressed.filter((el) => el.selectable).map(nameOf)).toEqual([]);
  });

  it("says each `user-select` both ways, since WKWebView reads only the prefixed one", () => {
    expect(unpairedSelects(OWN)).toEqual([]);
  });
});
