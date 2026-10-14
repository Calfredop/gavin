// What selects on a phone, read off phone.css and a surface's own markup
// and `<style>`, for the guards in both webviews (the bundle's
// seam/selection.test.ts, the shell's surfaces/selection.test.ts).
//
// phone.css turns selection off on the page and back on for what is read;
// a surface opts its own readable text back in by class. The suites have
// no page to compute a style on, so what this holds is what the rules say,
// matched against the elements the markup draws: a selector's last
// compound against an element's tag, classes and attributes, and selection
// inherited down the markup from the nearest element a rule names. A rule
// reaching into another component (`:global`) or holding only in a state
// (`:active`) names nothing here.
import { rulesOf, splitList, type StyleRule } from "./styleRules";
import { componentRules } from "./safeArea";

export interface Drawn {
  file: string;
  tag: string;
  classes: string[];
  /// The opening tag's attributes, as written.
  attrs: string;
  /// It holds `{@html ...}`: prose rendered from text.
  html: boolean;
  /// It is pressed, or sits inside something that is.
  pressed: boolean;
  selectable: boolean;
}

/// The three rules phone.css holds selection with: off on the page, on
/// for what is read, off again for what is pressed.
export function selectionRules(phoneCss: string): {
  root: StyleRule | undefined;
  read: StyleRule | undefined;
  press: StyleRule | undefined;
} {
  const rules = rulesOf(phoneCss).filter((rule) => rule.within.length === 0 && rule.declarations.has("user-select"));
  const valued = (value: string) => rules.filter((rule) => rule.declarations.get("user-select") === value);
  return {
    root: valued("none").find((rule) => rule.selectors.includes("html")),
    read: valued("text")[0],
    press: valued("none").find((rule) => rule.selectors.includes("button")),
  };
}

const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/// Where the bracket opened at `from` closes, `{...}` nested.
function closing(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length;
}

/// A tag's attributes, from after its name to its `>`: past any `>` in a
/// `{...}` (an arrow function) or a quoted value, and past the quotes of a
/// string inside a `{...}` inside a quoted value.
function attributesAt(text: string, from: number): [string, number] {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") i = closing(text, i);
    else if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return [text.slice(from, i), i];
  }
  return [text.slice(from), text.length];
}

/// An element's classes: the plain ones written in `class="..."`, and each
/// `class:name` directive's, since it may be on. A class built from an
/// expression is no name a rule can be held to.
function classesOf(attrs: string): string[] {
  const at = /\bclass="/.exec(attrs);
  let written = "";
  if (at) {
    for (let i = at.index + at[0].length; i < attrs.length && attrs[i] !== '"'; i++) {
      if (attrs[i] === "{") {
        i = closing(attrs, i);
        written += "{}";
      } else written += attrs[i];
    }
  }
  const plain = written.split(/\s+/).filter((c) => c !== "" && !/[{}]/.test(c));
  const directives = [...attrs.matchAll(/\bclass:([\w-]+)/g)].map((m) => m[1]);
  return [...plain, ...directives];
}

/// Whether one compound selector (`button`, `.note.problem`,
/// `[contenteditable]:not([contenteditable="false"])`) names an element.
/// A state (`:active`, `:focus-visible`) or anything unread names nothing.
function compoundMatches(compound: string, el: Pick<Drawn, "tag" | "classes" | "attrs">): boolean {
  let rest = compound;
  const nots: string[] = [];
  rest = rest.replace(/:not\(((?:[^()]|\([^()]*\))*)\)/g, (_, inner: string) => {
    nots.push(inner);
    return "";
  });
  const attrTests: Array<[string, string | null]> = [];
  rest = rest.replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_, name: string, value: string | undefined) => {
    attrTests.push([name, value ?? null]);
    return "";
  });
  const m = /^([a-z][a-z0-9]*|\*)?((?:\.[\w-]+)*)$/.exec(rest);
  if (!m) return false;
  if (m[1] && m[1] !== "*" && m[1] !== el.tag) return false;
  const classes = m[2].split(".").filter(Boolean);
  if (!classes.every((c) => el.classes.includes(c))) return false;
  for (const [name, value] of attrTests) {
    const found = new RegExp(`(?:^|\\s)${name}(?:="([^"]*)")?(?=[\\s/]|$)`).exec(el.attrs);
    if (!found || (value !== null && found[1] !== value)) return false;
  }
  return nots.every((inner) => !splitList(inner).some((s) => compoundMatches(s, el)));
}

/// Whether a selector names the element: its last compound does. One that
/// reaches into another component through `:global` names nothing here.
export function selectorMatches(selector: string, el: Pick<Drawn, "tag" | "classes" | "attrs">): boolean {
  if (selector.includes(":global")) return false;
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) from = i + 1;
  }
  return compoundMatches(selector.slice(from), el);
}

function ruleMatches(rule: StyleRule, el: Pick<Drawn, "tag" | "classes" | "attrs">): boolean {
  return rule.selectors.some((s) => selectorMatches(s, el));
}

/// Every element a surface's markup draws, components left out, with
/// whether it is pressed and whether its text selects.
export function drawnElements(sources: Record<string, string>, phoneCss: string): Drawn[] {
  const { read, press } = selectionRules(phoneCss);
  const out: Drawn[] = [];
  for (const [file, source] of Object.entries(sources)) {
    if (!file.endsWith(".svelte")) continue;
    const own = componentRules({ [file]: source }).filter((rule) => rule.declarations.has("user-select"));
    const text = source
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const open: Array<{ tag: string; drawn: Drawn | null }> = [];
    const parent = (): Drawn | null => [...open].reverse().find((o) => o.drawn)?.drawn ?? null;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{") {
        const end = closing(text, i);
        if (text.startsWith("{@html", i)) {
          const holder = parent();
          if (holder) holder.html = true;
        }
        i = end;
        continue;
      }
      if (text[i] !== "<") continue;
      const close = /^<\/([\w.:-]+)\s*>/.exec(text.slice(i, i + 64));
      if (close) {
        const at = open.map((o) => o.tag).lastIndexOf(close[1]);
        if (at >= 0) open.length = at;
        i += close[0].length - 1;
        continue;
      }
      const name = /^<([A-Za-z][\w.:-]*)/.exec(text.slice(i, i + 64));
      if (!name) continue;
      const [attrs, end] = attributesAt(text, i + name[0].length);
      const tag = name[1];
      const selfClosing = /\/\s*$/.test(attrs);
      let drawn: Drawn | null = null;
      if (/^[a-z]/.test(tag) && !tag.includes(":")) {
        const el = { tag, classes: classesOf(attrs), attrs };
        const above = parent();
        const pressedHere = press !== undefined && ruleMatches(press, el);
        const readHere = read !== undefined && ruleMatches(read, el);
        const ownValue = [...own].reverse().find((rule) => ruleMatches(rule, el))?.declarations.get("user-select");
        const selectable =
          ownValue !== undefined
            ? ownValue === "text"
            : pressedHere
              ? false
              : readHere
                ? true
                : (above?.selectable ?? false);
        // A field inside the label that is its hit area is typed in, not pressed.
        const pressed = pressedHere || (!readHere && (above?.pressed ?? false));
        drawn = { file, ...el, html: false, pressed, selectable };
        out.push(drawn);
      }
      if (!selfClosing && !VOID.has(tag)) open.push({ tag, drawn });
      i = end;
    }
  }
  return out;
}

/// What marks an element as text a person reads or pastes: an error line
/// (`role="alert"`, or a `problem`, `error` or `warn` class), a block of
/// code, or prose rendered from markdown.
export function isReadable(el: Drawn): boolean {
  return (
    /\brole="alert"/.test(el.attrs) ||
    el.tag === "pre" ||
    el.tag === "code" ||
    el.html ||
    el.classes.some((c) => c === "problem" || c === "error" || c === "warn")
  );
}

/// `file tag.class.class`, how a guard names an element.
export function nameOf(el: Drawn): string {
  return `${el.file} ${el.tag}${el.classes.map((c) => `.${c}`).join("")}`;
}

/// Whether an element is the one a guard names: by its tag and the
/// classes the name gives, whatever other classes it carries.
export function isNamed(el: Drawn, name: string): boolean {
  const [file, element] = [name.slice(0, name.lastIndexOf(" ")), name.slice(name.lastIndexOf(" ") + 1)];
  const [tag, ...classes] = element.split(".");
  return el.file === file && el.tag === tag && classes.every((c) => el.classes.includes(c));
}

/// Each `user-select` in a stylesheet without its `-webkit-` twin of the
/// same value, or the other way round. WKWebView honours only the prefixed
/// one, so the plain one alone does nothing on an iPhone.
export function unpairedSelects(sources: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const css = file.endsWith(".css")
      ? text
      : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    for (const rule of rulesOf(css)) {
      const plain = rule.declarations.get("user-select");
      const prefixed = rule.declarations.get("-webkit-user-select");
      if (plain !== prefixed) found.push(`${file} ${rule.selectors.join(", ")}`);
    }
  }
  return found;
}
