import { describe, it, expect } from "vitest";

// Several components in this app paint themselves `position: absolute;
// inset: 0` at their own root, because the pane they were built for
// stacks its tabs on one rectangle and hides the inactive ones with
// `visibility` -- they all have to occupy it at once. Modal does the
// same in its `inline` form, and says so in its own comment: "the host
// is responsible for being a positioned box".
//
// That makes a contract every call site owes them, and it is invisible
// in every other suite: the element they are mounted into must ESTABLISH
// A CONTAINING BLOCK. Give one a static parent and it does not merely
// sit wrong -- it leaves the column entirely and fills the nearest
// positioned ancestor, which in the hub is `.view` in +page.svelte, i.e.
// the whole tab.
//
// Both halves of that happened on the Review tab in one afternoon.
// Measured in WKWebView: the agent column should have been
// [280, 54, 192, 546] and the terminal covered [0, 0, 1000, 600],
// painting over the card list, the touched files and the diff; the tab
// read as a bare agent session, which is what it was reported as. The
// Session/Plan switch added a fortnight later repeated it exactly, with
// CardDetailModal's inline panel over the same three columns.
//
// So the rule is derived rather than listed: a component whose root is
// absolutely positioned is found from the sources, and every call site
// of one is checked. Pinning TerminalPane alone is what let the second
// one through.

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

interface OpenTag {
  tag: string;
  /// Only the STATIC classes. A `class:x={cond}` directive is a class the
  /// element sometimes has, and "sometimes positioned" is not a
  /// containing block you can mount a pane into.
  classes: string[];
  index: number;
  end: number;
}

const TAG = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;

function readTag(m: RegExpExecArray): OpenTag {
  const cls = /\bclass="([^"]*)"/.exec(m[3]);
  return {
    tag: m[2],
    classes: cls ? cls[1].trim().split(/\s+/).filter(Boolean) : [],
    index: m.index,
    end: m.index + m[0].length,
  };
}

/// The stack of open tags enclosing `index`, outermost first. Components
/// are pushed too -- they nest like elements as far as the markup is
/// concerned -- but only one with a class can answer the question below.
function openTags(masked: string, index: number): OpenTag[] {
  const stack: OpenTag[] = [];
  const re = new RegExp(TAG.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (m.index >= index) break;
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === m[2]) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (VOID_ELEMENTS.has(m[2].toLowerCase()) || m[3].trimEnd().endsWith("/")) continue;
    stack.push(readTag(m));
  }
  return stack;
}

/// Every tag a component opens at the TOP LEVEL of its markup -- the
/// ones with no element around them.
///
/// All of them, not "the first one": a component legitimately has
/// several roots (an `{#if}` with two branches, a modal beside the
/// `<svelte:window>` that feeds it), and `{#snippet}` blocks put whole
/// subtrees up here too. CardDetailModal is exactly that shape -- a
/// snippet defining a fold header, and only then the `<Modal>` that is
/// the panel -- so taking the first tag called its root a `<button>` and
/// quietly dropped the component off this rule.
function topLevelTags(masked: string): OpenTag[] {
  const tags: OpenTag[] = [];
  const stack: string[] = [];
  const re = new RegExp(TAG.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i] === m[2]) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const selfClosing = VOID_ELEMENTS.has(m[2].toLowerCase()) || m[3].trimEnd().endsWith("/");
    if (stack.length === 0) tags.push(readTag(m));
    if (!selfClosing) stack.push(m[2]);
  }
  return tags;
}

/// Every class this component's own `<style>` gives a non-static
/// `position`. Read off the selectors rather than matched to one rule
/// shape, so `.terminal`, `.pane.wide` and `.a, .terminal` all count.
function positionedClasses(source: string): Set<string> {
  const positioned = new Set<string>();
  for (const [cls, decls] of classDeclarations(source)) {
    const declared = /(?:^|[;{\s])position\s*:\s*([a-z]+)/.exec(decls);
    if (declared && declared[1] !== "static") positioned.add(cls);
  }
  return positioned;
}

/// Every declaration a stylesheet makes about each class, concatenated.
/// Concatenated because the answer is often split across rules: Modal
/// takes `inset: 0` from `.backdrop` and `position: absolute` from
/// `.backdrop.inline`, and neither rule alone says what the panel does.
function classDeclarations(source: string): Map<string, string> {
  // Comments stripped FIRST, and it is not tidiness: a comment carries
  // no braces, so it lands in the prelude of the rule beneath it, and
  // its prose is read as that rule's selector. The comment on `.plan` in
  // ReviewAgentPane says "for the same reason `.terminal` above is",
  // which credited `.terminal` with `.plan`'s `position: relative` and
  // made this whole suite pass with the bug restored. Caught by deleting
  // the fix and watching the test stay green.
  const style = (/<style[^>]*>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? "").replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );
  const byClass = new Map<string, string>();
  for (const [, prelude, body] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const cls of prelude.matchAll(/\.([\w-]+)/g)) {
      byClass.set(cls[1], `${byClass.get(cls[1]) ?? ""};${body}`);
    }
  }
  return byClass;
}

/// Whether a class paints an absolutely positioned box that FILLS its
/// host. That last word is the whole distinction, and BoardSelectionBar
/// is why it is here: it is `position: absolute; bottom: 16px; left:
/// 50%` -- a bar floating over the board, which wants the nearest
/// positioned ancestor it can get and is correct as a bare sibling. A
/// pane that fills its host is a different animal: give IT the wrong
/// ancestor and it covers everything between here and there.
function fillsItsHost(source: string, cls: string): boolean {
  const decls = classDeclarations(source).get(cls) ?? "";
  const declared = /(?:^|[;{\s])position\s*:\s*([a-z]+)/.exec(decls);
  if (!declared || (declared[1] !== "absolute" && declared[1] !== "fixed")) return false;
  const fills =
    /(?:^|[;{\s])inset\s*:\s*0/.test(decls) ||
    (/(?:^|[;{\s])width\s*:\s*100%/.test(decls) && /(?:^|[;{\s])height\s*:\s*100%/.test(decls));
  return fills;
}

const componentName = (file: string): string => file.replace(/\.svelte$/, "");

/// The components that need their host to be a positioned box, and the
/// class each one paints itself with.
///
/// "always" -- the root is absolutely positioned outright.
/// "inline" -- only when the call site passes `inline`, which is Modal's
/// bargain: without it the backdrop is `fixed` and anchors itself to the
/// window, needing no host at all.
///
/// A written list rather than a derivation, for appHeader.test.ts's
/// reason: what a component's root IS cannot be read off the source
/// reliably enough to accuse anyone. A `{#snippet}` puts a whole subtree
/// at the top level (CardDetailModal defines a fold header before the
/// `<Modal>` that is the panel), an `{#if}` gives a component two roots,
/// and a menu or drag ghost is a top-level filling box that is NOT the
/// component. So the list is stated, every entry is checked against the
/// stylesheet below so it cannot go stale, and `no unlisted pane` catches
/// the next one to be written.
const PANES: [string, string, "always" | "inline"][] = [
  ["TerminalPane", "pane", "always"],
  ["FileViewerPane", "pane", "always"],
  ["CardTabPane", "pane", "always"],
  ["FollowUpQueuePane", "pane", "always"],
  ["BoardPane", "board-pane", "always"],
  // The wrappers below are Modal-rooted and forward `inline`, so they
  // inherit its bargain: with the flag they fill their host, without it
  // they are dialogs over the window.
  ["Modal", "backdrop", "inline"],
  ["CardDetailModal", "backdrop", "inline"],
  ["RunChangesModal", "backdrop", "inline"],
  ["FollowUpQueueView", "backdrop", "inline"],
];

const KINDS = new Map<string, "always" | "inline">(
  PANES.map(([name, , kind]) => [name, kind])
);

/// Where each listed pane's own filling rule lives -- its own file, or
/// Modal's for the wrappers that forward to it.
function paneStyleSource(name: string): string {
  return SOURCES[`./${name}.svelte`] ?? "";
}

interface CallSite {
  file: string;
  component: string;
  index: number;
}

function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    const file = path.replace("./", "");
    const masked = maskMarkup(text);
    const re = new RegExp(TAG.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[1]) continue;
      const kind = KINDS.get(m[2]);
      if (!kind) continue;
      // `inline` is read off the RAW tag: it is written as the bare
      // shorthand, which survives masking, but `inline={x}` would not.
      if (kind === "inline" && !/\binline\b/.test(text.slice(m.index, m.index + m[0].length))) {
        continue;
      }
      sites.push({ file, component: m[2], index: m.index });
    }
  }
  return sites;
}

const SITES = callSites();

describe("absolutely positioned panes", () => {
  it("really do fill their host -- every listed entry checked against its stylesheet", () => {
    for (const [name, cls] of PANES) {
      const source = name === "Modal" ? SOURCES["./Modal.svelte"] : paneStyleSource(name);
      const where = name === "Modal" || cls === "backdrop" ? SOURCES["./Modal.svelte"] : source;
      expect(`${name}: ${fillsItsHost(where, cls)}`).toBe(`${name}: true`);
    }
    // And the half of Modal's bargain that makes `inline` the trigger:
    // without it the backdrop is fixed, which needs no host.
    expect(SOURCES["./Modal.svelte"]).toMatch(/\.backdrop\s*\{[^}]*position:\s*fixed/);
    expect(SOURCES["./Modal.svelte"]).toMatch(/\.backdrop\.inline\s*\{[^}]*position:\s*absolute/);
  });

  it("names every pane whose FIRST top-level element fills its host", () => {
    // The safety net under the written list: a component built the
    // obvious way -- one root, absolutely filling -- must be in it. The
    // ones the list holds beyond this are the awkward shapes the comment
    // on PANES describes.
    const derived = Object.entries(SOURCES)
      .filter(([, text]) => {
        const first = topLevelTags(maskMarkup(text))[0];
        return first ? first.classes.some((cls) => fillsItsHost(text, cls)) : false;
      })
      .map(([path]) => componentName(path.replace("./", "")));
    expect(derived.filter((name) => !KINDS.has(name))).toEqual([]);
  });

  it("have call sites to check -- a rule with nothing to check has stopped being one", () => {
    expect(SITES.length).toBeGreaterThan(0);
    // The two that taught us the rule, by name, so a refactor that
    // renames either does not silently empty this suite.
    expect(SITES.some((s) => s.component === "TerminalPane")).toBe(true);
    expect(SITES.some((s) => s.component === "CardDetailModal")).toBe(true);
  });

  it("are each mounted into an element that establishes a containing block", () => {
    const escaping = SITES.filter(({ file, index }) => {
      const source = SOURCES[`./${file}`];
      const parent = openTags(maskMarkup(source), index).at(-1);
      // No enclosing element means this call site IS one of the
      // component's own roots, so the obligation is not owed here -- it
      // is forwarded to whoever mounts THIS component. That only holds
      // if the list above actually carries the forward, so it is checked
      // rather than assumed.
      if (!parent) return !KINDS.has(componentName(file));
      // A parent that is itself one of these panes is positioned by
      // definition, so it anchors whatever it holds.
      if (KINDS.has(parent.tag)) return false;
      const positioned = positionedClasses(source);
      return !parent.classes.some((cls) => positioned.has(cls));
    });
    expect(escaping.map((s) => `${s.file} \u2192 <${s.component}>`)).toEqual([]);
  });
});
