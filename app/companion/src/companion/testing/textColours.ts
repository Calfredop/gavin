// Reading colours as text, for the guards that hold what the phone's
// text reads at. The suites have no page to compute a colour on, so what
// they can hold is what the stylesheets say: the colours theme.css gives
// each role, and the role each component paints its text in.
import { allSources } from "$lib/sources";

export type Theme = "dark" | "light";

/// `#rgb` or `#rrggbb` as its three channels, 0 to 255.
function channels(hex: string): [number, number, number] {
  let digits = hex.replace(/^#/, "");
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join("");
  if (!/^[0-9a-f]{6}$/i.test(digits)) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as [number, number, number];
}

/// WCAG 2's relative luminance: 0 for black, 1 for white.
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/// WCAG 2's contrast ratio, the lighter colour over the darker: 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/// Each custom property theme.css sets on the root, per theme, followed
/// through `var()` to the colour it draws. A property that is no colour
/// (a length, a font) is left out. Bare `:root` carries the dark values,
/// and `[data-theme="light"]` out-ranks it, as in the page.
export function themeColours(css: string): Record<Theme, Record<string, string>> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const root: Record<string, string> = {};
  const light: Record<string, string> = {};
  for (const [, prelude, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = prelude.split(",").map((s) => s.trim());
    const into = selectors.includes(':root[data-theme="light"]') ? light : selectors.includes(":root") ? root : null;
    if (!into) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) into[name] = value.trim();
  }
  const resolve = (props: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const name of Object.keys(props)) {
      let value: string | undefined = props[name];
      for (let hops = 0; value && hops < 8; hops++) {
        const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
        if (!ref) break;
        value = props[ref[1]];
      }
      if (value && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) out[name] = value.toLowerCase();
    }
    return out;
  };
  return { dark: resolve(root), light: resolve({ ...root, ...light }) };
}

/// A role meant for text, by its name: `--text`, `--text-*`, `--*-text`.
/// Everything else (`--accent`, `--success`) is a fill or a line, and
/// stays vivid where the text roles step back to a readable shade.
export function isTextRole(name: string): boolean {
  return /^--text(-[a-z]+)?$/.test(name) || /^--[a-z]+-text$/.test(name);
}

/// A desktop component the bundle imports, by the path it imports it as.
function libSource(lib: Record<string, string>, importPath: string): [string, string] | null {
  const path = importPath.replace(/^\$lib\//, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const text = lib[name] ?? lib[path];
  return text === undefined ? null : [`$lib/${path}`, text];
}

/// Every component a phone draws: the given ones, and each desktop
/// component they import, and theirs, all the way down.
export function drawnComponents(own: Record<string, string>): Record<string, string> {
  const lib = allSources();
  const out: Record<string, string> = Object.fromEntries(
    Object.entries(own).filter(([path]) => path.endsWith(".svelte"))
  );
  const queue = Object.values(out);
  while (queue.length > 0) {
    const text = queue.pop() as string;
    for (const [, path] of text.matchAll(/from\s+"(\$lib\/[^"]+\.svelte)"/g)) {
      const found = libSource(lib, path);
      if (found && !(found[0] in out)) {
        out[found[0]] = found[1];
        queue.push(found[1]);
      }
    }
  }
  return out;
}

/// The CSS a source carries: a stylesheet whole, a component's `<style>`
/// blocks and its inline `style="..."` attributes, comments taken out.
function cssOf(path: string, text: string): string {
  const css = path.endsWith(".css")
    ? text
    : [
        ...[...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]),
        ...[...text.matchAll(/\bstyle="([^"{}]*)"/g)].map((m) => `{${m[1]}}`),
      ].join("\n");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const KEYWORDS = /^(inherit|currentcolor|transparent|initial|unset)$/i;

/// Each `color:` in the sources whose text does not come from a text
/// role, as `file: color: value`: a literal colour, or a fill role such
/// as `--accent`, named directly or through a custom property the same
/// source sets (`--tab-tone: var(--accent)` read by `color:
/// var(--tab-tone)`). A text role is the one thing theme.css holds at
/// 4.5:1 on every surface; anything else is unmeasured.
export function untextedColours(sources: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const css = cssOf(file, text);
    const sets = new Map<string, string[]>();
    for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
      sets.set(name, [...(sets.get(name) ?? []), value.trim()]);
    }
    const textual = (value: string, seen: Set<string>): boolean => {
      const v = value.replace(/!important/, "").trim();
      if (KEYWORDS.test(v)) return true;
      // Anything left once every `var(--name` is taken out is a literal.
      if (v.replace(/var\(\s*--[\w-]+/g, "").replace(/[\s,()]/g, "") !== "") return false;
      return [...v.matchAll(/var\(\s*(--[\w-]+)/g)].every(([, name]) => {
        if (isTextRole(name)) return true;
        const values = sets.get(name);
        if (!values || seen.has(name)) return false;
        return values.every((inner) => textual(inner, new Set([...seen, name])));
      });
    };
    for (const [, value] of css.matchAll(/(?:^|[;{\s])color\s*:\s*([^;{}]+)/g)) {
      if (!textual(value, new Set())) found.push(`${file}: color: ${value.trim()}`);
    }
  }
  return found;
}
