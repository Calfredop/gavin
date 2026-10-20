// What a person presses never selects; what they read does.
//
// On a phone a press held a moment too long on a button, a tab or a row
// starts a text selection, and on iOS the callout, instead of the control's
// own gesture. phone.css turns selection off on the page, as the desktop
// window's own `src/routes/+page.svelte` does, and back on for fields, code
// and error lines; each surface opts its own readable text back in by
// class. This holds the three rules, and both directions of the sweep: an
// error line, a block of code or rendered prose on a phone surface comes
// out selectable, and nothing pressed does. The shell's hub is held the
// same way (its surfaces/selection.test.ts).
import { describe, expect, it } from "vitest";
import { allSources } from "$lib/sources";
import { companionSource, companionSources } from "$companion/testing/companionSources";
import { componentRules } from "$companion/testing/safeArea";
import {
  drawnElements,
  isNamed,
  isReadable,
  nameOf,
  selectionRules,
  unpairedSelects,
} from "$companion/testing/selection";
import phoneCss from "$companion/surfaces/phone.css?raw";

const OWN = companionSources();
/// The desk window's own pages, which load the desktop's library.
const DESK_ROUTES = import.meta.glob("../../../../src/routes/**/*.{svelte,ts}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const DRAWN = drawnElements(OWN, phoneCss);
const { root, read, press } = selectionRules(phoneCss);

/// Text the sweep's markers do not find, that is there to read or copy.
const READ = [
  "companion/surfaces/PhoneMarkdown.svelte div.markdown",
  "companion/surfaces/PhoneCard.svelte pre.prompt",
  "companion/surfaces/PhoneCard.svelte span.where",
  "companion/surfaces/PhoneBrowser.svelte span.url",
  "companion/surfaces/PhoneWorkspaceSettings.svelte span.folder",
  "companion/surfaces/PhoneGit.svelte span.agent-why",
  "routes/+page.svelte p.detail",
];

/// What a thumb presses, named so that the sweep sees it at all.
const PRESSED = [
  "companion/surfaces/SurfaceTabs.svelte button.tab",
  "companion/surfaces/WorkspaceList.svelte button.row",
  "companion/surfaces/PhoneSessions.svelte button.row",
  "companion/surfaces/PhoneHeader.svelte button.back",
  "companion/surfaces/PhoneItems.svelte button.open",
  "companion/surfaces/PhoneTerminal.svelte button.key",
];

describe("selection on a phone", () => {
  it("is off on the page, callout too, in a rule no media query holds", () => {
    expect(root?.within).toEqual([]);
    expect(Object.fromEntries(root?.declarations ?? [])).toMatchObject({
      "-webkit-user-select": "none",
      "user-select": "none",
      "-webkit-touch-callout": "none",
    });
  });

  it("is back on for a field, code and an error line, and off again for what is pressed", () => {
    expect(read?.selectors).toEqual(
      expect.arrayContaining(["input", "textarea", "pre", "code", '[role="alert"]'])
    );
    expect(press?.selectors).toEqual(
      expect.arrayContaining(["button", "summary", "label", '[role="button"]', '[role="tab"]'])
    );
  });

  it("reaches the bundle's every page, and never the desk's window", () => {
    expect(companionSource("routes/+layout.svelte")).toContain('import "$companion/surfaces/phone.css";');
    // The glob finding the desk's page at all, or a sweep over nothing passes.
    expect(Object.keys(DESK_ROUTES).some((path) => path.endsWith("/+page.svelte"))).toBe(true);
    const desk = Object.entries({ ...allSources(), ...DESK_ROUTES })
      .filter(([, text]) => text.includes("phone.css"))
      .map(([path]) => path);
    expect(desk).toEqual([]);
  });

  it("selects every error line, block of code and rendered prose a phone surface draws", () => {
    const readable = DRAWN.filter((el) => isReadable(el) && !el.pressed);
    // The sweep sees them at all: a card's problem line, an alert, the prompt.
    expect(readable.length).toBeGreaterThan(10);
    expect(readable.filter((el) => !el.selectable).map(nameOf)).toEqual([]);
  });

  it("selects the paths, names and reasons a person reads off or copies", () => {
    for (const name of READ) {
      const found = DRAWN.filter((el) => isNamed(el, name));
      expect(found.length, name).toBeGreaterThan(0);
      expect(found.filter((el) => !el.selectable).map(nameOf), name).toEqual([]);
    }
  });

  it("selects what the agent asked on a card and in Decisions, inside the desk's own row", () => {
    // The desk's row leaves its text to the window's default, so the phone
    // opts it in from outside: by the row's own class names.
    const row = allSources()["DecisionsItemRow.svelte"] ?? "";
    expect(row).toContain('<span class="text">');
    expect(row).toContain('<p class="latest">');
    for (const file of ["companion/surfaces/PhoneCard.svelte", "companion/surfaces/PhoneItems.svelte"]) {
      const rule = componentRules({ [file]: OWN[file] }).find((r) => r.selectors.includes(".items :global(.text)"));
      expect(rule?.selectors, file).toContain(".items :global(.latest)");
      expect(rule?.declarations.get("user-select"), file).toBe("text");
    }
  });

  it("selects nothing a person presses", () => {
    const pressed = DRAWN.filter((el) => el.pressed);
    for (const name of PRESSED) expect(pressed.some((el) => isNamed(el, name)), name).toBe(true);
    expect(pressed.filter((el) => el.selectable).map(nameOf)).toEqual([]);
  });

  it("says each `user-select` both ways, since WKWebView reads only the prefixed one", () => {
    expect(unpairedSelects({ ...OWN, "companion/surfaces/phone.css": phoneCss })).toEqual([]);
  });

  it("raises no callout anywhere", () => {
    const callouts = Object.entries({ ...OWN, "companion/surfaces/phone.css": phoneCss }).flatMap(([file, text]) =>
      [...text.matchAll(/-webkit-touch-callout:\s*([^;}\s]+)/g)].filter((m) => m[1] !== "none").map(() => file)
    );
    expect(callouts).toEqual([]);
  });
});
