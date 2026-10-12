// The phone's text size reaches every size the bundle draws.
//
// On an iPhone 16 Pro at the largest accessibility text size nothing on
// either webview moved: the root was a fixed size, and WKWebView follows
// Dynamic Type only for text that asks for a system style. Now the root is
// 16px times `--text-scale`, which surfaces/textScale.ts reads off a probe
// in iOS's body style, and a size moves with it only if it is written
// against the root: `rem`, or `em` through the body. A size in `px` stays
// where it is -- so this lists every one in what the bundle draws, its own
// surfaces and phone.css and each desktop component inside them, and
// holds that each is a floor that grows (`max(16px, 1rem)`, a field's
// no-zoom floor) or on the list below with why it need not move.
import { describe, expect, it } from "vitest";
import { codeOf, companionSource, companionSources } from "$companion/testing/companionSources";
import { rulesOf } from "$companion/testing/styleRules";
import { drawnComponents } from "$companion/testing/textColours";
import { fixedSizes, sizesIn } from "$companion/testing/textSizes";
import phoneCss from "$companion/surfaces/phone.css?raw";

/// Sizes in px that do not move with the text, each with why.
const FIXED_SIZES: Record<string, string> = {
  "$lib/ui/ShortcutHint.svelte: 10px": "the badge shown while ⌘ is held, which a phone has no key for",
};

const ROOT = rulesOf(phoneCss).filter((rule) => rule.within.length === 0);

function sizeOf(selector: string): string | undefined {
  return ROOT.find((rule) => rule.selectors.includes(selector) && rule.declarations.has("font-size"))?.declarations.get(
    "font-size"
  );
}

describe("the root a phone's text size moves", () => {
  it("is 16px at the default text size, times the scale", () => {
    expect(sizeOf("html")).toBe("calc(16px * var(--text-scale, 1))");
  });

  it("is left to the scale, not to WebKit's own text sizing", () => {
    const root = ROOT.find((rule) => rule.selectors.includes("html") && rule.declarations.has("font-size"));
    expect(root?.declarations.get("-webkit-text-size-adjust")).toBe("100%");
  });

  it("reaches the desktop's components, which size themselves in `em` from the body", () => {
    expect(sizeOf("body")).toBe("1rem");
  });

  it("reaches a button no component sizes, which would keep the browser's fixed control size", () => {
    expect(sizeOf("button")).toBe("calc(13.333px * var(--text-scale, 1))");
  });

  it("is followed from the moment the page mounts", () => {
    expect(codeOf(companionSource("routes/+layout.svelte"))).toMatch(/onMount\(\(\) => followTextScale\(\)\)/);
  });

  it("sizes the terminal too", () => {
    const terminal = codeOf(companionSource("companion/surfaces/PhoneTerminal.svelte"));
    const sizes = [...terminal.matchAll(/<TerminalPane\b[^>]*\bfontSize=\{([^}]*)\}/g)].map((m) => m[1]);
    expect(sizes).toEqual(["terminalFontSize(DEFAULT_TERMINAL_FONT_SIZE, $textScale)"]);
  });
});

describe("a size in px", () => {
  const sources: Record<string, string> = {
    ...drawnComponents(companionSources()),
    "companion/surfaces/phone.css": phoneCss,
  };

  it("is read at all: the guard sees the bundle's own floors and the desktop's", () => {
    const all = Object.entries(sources).flatMap(([path, text]) => sizesIn(path, text).map((v) => `${path}: ${v}`));
    expect(all).toEqual(
      expect.arrayContaining([
        "companion/surfaces/phone.css: max(16px, 1em) !important",
        "companion/surfaces/PhoneCard.svelte: max(16px, 1rem)",
        "$lib/git/GitCommitBox.svelte: max(16px, 1em)",
        "$lib/ui/ShortcutHint.svelte: 10px",
      ])
    );
  });

  it("is a floor that grows, or on the list with why it need not move", () => {
    expect(fixedSizes(sources)).toEqual(Object.keys(FIXED_SIZES).sort());
  });
});
