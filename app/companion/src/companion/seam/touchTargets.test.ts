// Nothing a thumb presses is under 44px, and no text is under 11px.
//
// On an iPhone 16 Pro (402px, iOS 27) the bundle drew a dialog's buttons
// 26px tall, the Git rows' stage buttons 40x32, the colour swatches 32x32
// and a card page's column select 29px; its captions were 8.9px. The
// desktop's components size their controls for a cursor, several of the
// ones that grow for a coarse pointer grew to 32 or 40, and every size the
// phone's surfaces wrote in `rem` came out at 13/16 of itself, because
// `$lib/ui/theme.css` gives the root the bare `monospace`, 13px.
//
// The suites have no page to lay out at 402px, so this reads the
// stylesheets and the markup the bundle ships. What it holds: phone.css
// floors every kind of control the bundle draws at 44px, with nothing
// shipped out-ranking the floor; a tick box or a radio, which the floor
// leaves its own size, sits inside the label that is its hit area; any
// other element that takes a tap is on the list below with the reason;
// and nothing the phone's own surfaces size is set under
// 11px. A desktop component's `em` sizes compound through what holds
// them, out of a stylesheet reader's reach -- those were measured, screen
// by screen, at 402px with a coarse pointer, and set where they live.
import { describe, expect, it } from "vitest";
import { allSources } from "$lib/sources";
import { codeOf, companionSources } from "$companion/testing/companionSources";
import { floorPx, rulesOf, splitList, type StyleRule } from "$companion/testing/styleRules";
import { drawnComponents } from "$companion/testing/textColours";
import phoneCss from "$companion/surfaces/phone.css?raw";
import themeCss from "$lib/ui/theme.css?raw";
import xtermCss from "@xterm/xterm/css/xterm.css?raw";

const TARGET_PX = 44;
const CAPTION_PX = 11;
/// What `rem` is once phone.css has set the root, at the phone's default
/// text size (seam/textScale.test.ts holds the root).
const ROOT_PX = 16;

/// Elements that take a tap and are no control, each with why it may be
/// any size: the floor does not reach them, and need not.
const TAPPABLE_EXCEPTIONS: Record<string, string> = {
  "companion/surfaces/PhoneBoard.svelte div.pager": "the swipe surface: a whole screen of columns",
  "companion/surfaces/PhoneBoard.svelte div.slot": "wraps a whole card, which is a button of its own",
  "companion/surfaces/PhoneRails.svelte div.pager": "the swipe surface: a whole screen of rails",
  "companion/surfaces/PhoneMarkdown.svelte div.markdown":
    "follows a tap on a link in rendered prose; a link inside running text is the text's size",
};

const LIB = allSources();
const OWN = companionSources();

/// Every component the bundle draws: its own, and each desktop component
/// they import, and theirs, all the way down.
const DRAWN = drawnComponents(OWN);

/// The markup of a component: its script and style taken out.
function markupOf(text: string): string {
  return text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
}

/// The attributes of the tag opening at `from`: up to the first `>`
/// outside a `{...}`, since an arrow function has one of its own.
function attributesAt(markup: string, from: number): string {
  let depth = 0;
  for (let i = from; i < markup.length; i++) {
    const ch = markup[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return markup.slice(from, i);
  }
  return markup.slice(from);
}

interface Tag {
  file: string;
  tag: string;
  attrs: string;
  /// Where it opens in the file's markup.
  at: number;
}

function tagsOf(sources: Record<string, string>): Tag[] {
  const tags: Tag[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const markup = markupOf(text);
    for (const match of markup.matchAll(/<([a-z][a-z0-9]*)\b/g)) {
      const at = match.index as number;
      tags.push({ file, tag: match[1], attrs: attributesAt(markup, at + match[0].length), at });
    }
  }
  return tags;
}

const TAGS = tagsOf(DRAWN);

function typeOf(tag: Tag): string {
  return /\btype="([a-z-]+)"/.exec(tag.attrs)?.[1] ?? "text";
}

function roleOf(tag: Tag): string | null {
  return /\brole="([a-z]+)"/.exec(tag.attrs)?.[1] ?? null;
}

/// What a tag is to the floor: a kind its selectors name, or null for an
/// element the floor has no reason to reach.
function controlKind(tag: Tag): string | null {
  const role = roleOf(tag);
  if (role === "button" || role === "tab") return `[role="${role}"]`;
  if (tag.tag === "input") return `input ${typeOf(tag)}`;
  if (tag.tag === "a") return /\bhref=/.test(tag.attrs) ? "a[href]" : null;
  if (["button", "select", "summary", "textarea"].includes(tag.tag)) return tag.tag;
  return null;
}

/// For `input:not([type="..."], ...)`, the types it leaves out.
function inputTypesLeftOut(selector: string): string[] | null {
  if (selector === "input") return [];
  const not = /^input:not\((.*)\)$/.exec(selector);
  if (!not) return null;
  return splitList(not[1]).map((s) => /^\[type="?([a-z-]+)"?\]$/.exec(s)?.[1] ?? s);
}

function covers(rule: StyleRule, kind: string): boolean {
  if (kind.startsWith("input ")) {
    const type = kind.slice("input ".length);
    return rule.selectors.some((s) => {
      const leftOut = inputTypesLeftOut(s);
      return leftOut !== null && !leftOut.includes(type);
    });
  }
  if (kind === "textarea") return rule.selectors.some((s) => s === "textarea" || s.startsWith("textarea:not("));
  return rule.selectors.includes(kind);
}

const RULES = rulesOf(phoneCss);
const floorRule = RULES.find((rule) => rule.selectors.includes("button") && rule.declarations.has("min-height"));
/// Tick boxes and radios: their own size, inside a label.
const BOXES = new Set(["checkbox", "radio"]);

describe("the floor under every control", () => {
  it("is a rule of the page's stylesheet, on every screen", () => {
    expect(floorRule).toBeDefined();
    expect(floorRule?.within).toEqual([]);
  });

  it("is 44px both ways, and important, so a component's own smaller size does not win", () => {
    for (const property of ["min-width", "min-height"]) {
      const value = floorRule?.declarations.get(property) ?? "";
      expect({ property, value }).toEqual({ property, value: `${TARGET_PX}px !important` });
    }
  });

  it("leaves out only tick boxes, radios, hidden inputs and xterm's hidden input", () => {
    const leftOut = (floorRule?.selectors ?? []).flatMap((s) => inputTypesLeftOut(s) ?? []);
    expect(leftOut.sort()).toEqual(["checkbox", "hidden", "radio"]);
    expect(floorRule?.selectors).toContain("textarea:not(.xterm-helper-textarea)");
  });

  it("reaches every kind of control the bundle draws", () => {
    // The guard sees the bundle at all: its own surfaces and the desktop's
    // components inside them -- the confirm dialog, a Git row, the swatches.
    expect(Object.keys(DRAWN)).toEqual(
      expect.arrayContaining([
        "companion/surfaces/PhoneBoard.svelte",
        "$lib/core/AppDialog.svelte",
        "$lib/core/ConfirmPrompt.svelte",
        "$lib/git/GitFileRow.svelte",
        "$lib/core/ColourPicker.svelte",
      ])
    );
    const kinds = new Set(TAGS.map(controlKind).filter((k): k is string => k !== null));
    for (const kind of ["button", "select", "textarea", "input number", '[role="tab"]', '[role="button"]']) {
      expect(kinds).toContain(kind);
    }
    const unreached = [...kinds].filter(
      (kind) => !(kind.startsWith("input ") && BOXES.has(kind.slice(6))) && kind !== "input hidden"
    );
    expect(unreached.filter((kind) => floorRule === undefined || !covers(floorRule, kind))).toEqual([]);
  });

  it("puts every tick box and radio inside the label that is its hit area", () => {
    const boxes = TAGS.filter((tag) => tag.tag === "input" && BOXES.has(typeOf(tag)));
    // The guard sees them at all: the Amend box, a toggle, a checklist.
    expect(boxes.length).toBeGreaterThan(2);
    const loose = boxes.filter((tag) => {
      const before = markupOf(DRAWN[tag.file]).slice(0, tag.at);
      return before.lastIndexOf("<label") <= before.lastIndexOf("</label>");
    });
    expect(loose.map((tag) => `${tag.file} input[${typeOf(tag)}]`)).toEqual([]);
  });

  it("names why each other element the bundle's surfaces make tappable may be any size", () => {
    const own = TAGS.filter((tag) => tag.file in OWN && controlKind(tag) === null);
    const tappable = own
      .filter((tag) => /\b(onclick|ontouchstart|onpointerdown)=/.test(tag.attrs))
      .map((tag) => `${tag.file} ${tag.tag}.${/\bclass="([^" ]*)/.exec(tag.attrs)?.[1] ?? ""}`);
    expect([...new Set(tappable)].sort()).toEqual(Object.keys(TAPPABLE_EXCEPTIONS).sort());
  });

  it("is out-ranked by nothing the bundle ships: no other minimum size is important", () => {
    const sheets: Record<string, string> = {
      ...OWN,
      ...LIB,
      "$lib/ui/theme.css": themeCss,
      "@xterm/xterm/css/xterm.css": xtermCss,
    };
    const important = [
      /min-(width|height|inline-size|block-size)\s*:[^;{}"]*!important/i,
      /style:min-(width|height)\|important/,
      /setProperty\(\s*["']min-(width|height)["'][^)]*["']important["']/,
    ];
    const outranking = Object.entries(sheets)
      .filter(([, text]) => important.some((pattern) => pattern.test(text)))
      .map(([path]) => path);
    expect(outranking).toEqual([]);
    const importantMinimums = RULES.filter((rule) =>
      ["min-width", "min-height"].some((property) => /!important$/.test(rule.declarations.get(property) ?? ""))
    );
    expect(importantMinimums).toEqual([floorRule]);
  });

  it("has every select draw its own box, since WebKit sizes a native one to its font", () => {
    const own = RULES.find((rule) => rule.selectors.length === 1 && rule.selectors[0] === "select");
    expect(own?.within).toEqual([]);
    expect(own?.declarations.get("appearance")).toBe("none !important");
  });
});

describe("the type a phone reads", () => {
  it("sets nothing in the bundle's own surfaces under 11px", () => {
    const small: string[] = [];
    for (const [path, text] of Object.entries(OWN)) {
      if (!path.endsWith(".svelte")) continue;
      for (const [, value] of codeOf(text).matchAll(/font-size:\s*([^;}"]+)/g)) {
        const px = sizePx(value.trim());
        if (px !== null && px < CAPTION_PX) small.push(`${path}: ${value.trim()} (${px}px)`);
      }
    }
    // The guard sees sizes at all: the captions, written in rem.
    expect(Object.values(OWN).some((text) => /font-size:\s*0\.6875rem/.test(text))).toBe(true);
    expect(small).toEqual([]);
  });
});

/// What a size computes to in px where that is known without a page: px,
/// rem at the 16px root, or a `max()` floor. `em` and `%` are not.
function sizePx(value: string): number | null {
  const rem = /^(\d*\.?\d+)rem$/.exec(value);
  if (rem) return Number(rem[1]) * ROOT_PX;
  return floorPx(value);
}
