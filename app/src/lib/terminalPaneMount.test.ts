import { describe, it, expect } from "vitest";

// TerminalPane's root is `position: absolute; inset: 0`, and it has to
// be: Pane.svelte stacks every tab of a pane on the same rectangle and
// hides the inactive ones with `visibility`, which only works if they
// all occupy it at once.
//
// The consequence is a contract every call site owes it, and it is not
// the one terminalPaneSession.test.ts pins: the element a TerminalPane
// is mounted into must ESTABLISH A CONTAINING BLOCK. Give it a static
// parent and the terminal does not merely sit wrong -- it leaves the
// column entirely and fills the nearest positioned ancestor, which in
// the hub is `.view` in +page.svelte, i.e. the whole tab. Measured in
// WKWebView on 2026-09-07: the Review tab's agent column should have
// been [280, 54, 192, 546] and the terminal covered [0, 0, 1000, 600],
// painting over the card list, the touched files and the diff. The tab
// read as a bare agent session, which is what it was reported as.
//
// Nothing in the type system says that and no suite renders CSS: both
// call sites compile, and the broken one differs from the correct one
// by a single declaration in a `<style>` block nobody reads next to the
// markup. So it is pinned here, on the sources, the way
// terminalPaneSession.test.ts and reviewSurfaces.test.ts pin theirs.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/// Elements that never have children, so a tag scanner must not push
/// them. `<input>` is the one that actually appears above a terminal
/// (MainAgentPanel's launcher); the rest are here so the scanner is
/// answering about HTML rather than about this week's markup.
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/// Blanks every span a tag scanner must not read -- comments, the
/// `<script>` and `<style>` blocks, and every `{…}` expression --
/// replacing them with spaces so an index into the result still points
/// at the same character of the original.
///
/// The expressions are the reason this exists rather than a `[^>]*` tag
/// pattern: `onclick={() => …}` and `class:x={a > b}` both put a `>`
/// inside an attribute, and a scanner that ends the tag there loses the
/// element stack from that point on.
function maskMarkup(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  for (const re of [/<!--[\s\S]*?-->/g, /<script[\s\S]*?<\/script>/g, /<style[\s\S]*?<\/style>/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) blank(m.index, m.index + m[0].length);
  }
  // Braces last, and over the already-blanked text: an unbalanced `{`
  // inside a comment or a script would otherwise swallow the markup
  // that follows it.
  const text = out.join("");
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    if (depth > 0 && out[i] !== "\n") out[i] = " ";
    if (text[i] === "}") depth = Math.max(0, depth - 1);
  }
  return out.join("");
}

interface OpenElement {
  tag: string;
  /// Only the STATIC ones. A `class:x={cond}` directive is a class the
  /// element sometimes has, and "sometimes positioned" is not a
  /// containing block you can mount a terminal into.
  classes: string[];
}

/// The stack of open HTML elements enclosing `index`, outermost first.
/// Components are pushed too (they nest like elements as far as the
/// markup is concerned), but only an element with a class can answer
/// the question below.
function openElements(masked: string, index: number): OpenElement[] {
  const stack: OpenElement[] = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(masked)) !== null) {
    if (m.index >= index) break;
    const [, closing, name, attrs] = m;
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (VOID_ELEMENTS.has(name.toLowerCase()) || attrs.trimEnd().endsWith("/")) continue;
    const cls = /\bclass="([^"]*)"/.exec(attrs);
    stack.push({
      tag: name,
      classes: cls ? cls[1].trim().split(/\s+/).filter(Boolean) : [],
    });
  }
  return stack;
}

/// Every class this component's own `<style>` gives a non-static
/// `position`. Read off the selectors rather than matched to one rule
/// shape, so `.terminal`, `.pane.wide` and `.a, .terminal` all count.
function positionedClasses(source: string): Set<string> {
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? "";
  const positioned = new Set<string>();
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(style)) !== null) {
    const declared = /(?:^|[;{\s])position\s*:\s*([a-z]+)/.exec(m[2]);
    if (!declared || declared[1] === "static") continue;
    for (const cls of m[1].matchAll(/\.([\w-]+)/g)) positioned.add(cls[1]);
  }
  return positioned;
}

function callSites(): { file: string; index: number }[] {
  const sites: { file: string; index: number }[] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    if (path.endsWith("/TerminalPane.svelte")) continue;
    const masked = maskMarkup(text);
    let from = 0;
    for (;;) {
      const at = masked.indexOf("<TerminalPane", from);
      if (at === -1) break;
      sites.push({ file: path.replace("./", ""), index: at });
      from = at + 1;
    }
  }
  return sites;
}

describe("every TerminalPane call site", () => {
  it("exists -- a rule with nothing to check has stopped being a rule", () => {
    expect(callSites().length).toBeGreaterThan(0);
  });

  it("is why the rule exists: TerminalPane's own root is absolutely positioned", () => {
    const root = SOURCES["./TerminalPane.svelte"];
    expect(root).toMatch(/\.pane\s*\{[^}]*position:\s*absolute/);
  });

  it("mounts into an element that establishes a containing block", () => {
    const escaping = callSites().filter(({ file, index }) => {
      const source = SOURCES[`./${file}`];
      const parent = openElements(maskMarkup(source), index).at(-1);
      if (!parent) return true;
      const positioned = positionedClasses(source);
      return !parent.classes.some((cls) => positioned.has(cls));
    });
    expect(escaping.map((s) => s.file)).toEqual([]);
  });
});
