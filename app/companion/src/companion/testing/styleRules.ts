// Reading a stylesheet as text, for the guards that hold what a phone's
// screen needs. The suites have no page to compute a style or a layout
// on, so what a guard can hold is what the rules say.

export interface StyleRule {
  selectors: string[];
  declarations: Map<string, string>;
  /// The at-rules it sits inside, outermost first.
  within: string[];
}

/// A comma-separated list, split only where the comma is not inside
/// brackets, each part with its whitespace folded.
export function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(list.slice(from));
  return parts.map((p) => p.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim());
}

/// The style rules of a plain stylesheet (no nesting, no braces in
/// strings -- phone.css, a component's `<style>`), each with the
/// at-rules around it.
export function rulesOf(css: string): StyleRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: StyleRule[] = [];
  const open: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      open.push(text.slice(from, i).trim());
      from = i + 1;
    } else if (ch === "}") {
      const prelude = open.pop() ?? "";
      if (!prelude.startsWith("@")) {
        const declarations = new Map<string, string>();
        for (const line of text.slice(from, i).split(";")) {
          const colon = line.indexOf(":");
          if (colon > 0) declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        rules.push({ selectors: splitList(prelude), declarations, within: [...open] });
      }
      from = i + 1;
    } else if (ch === ";" && (open.length === 0 || open[open.length - 1].startsWith("@"))) {
      // An at-rule statement (`@import ...;`), not a declaration.
      from = i + 1;
    }
  }
  return rules;
}

/// The least a length can compute to, in px, where that is known without
/// a page: a px length, or a `max()` with one among its arguments. `rem`,
/// `em` and `%` are no floor -- `rem` is 13px in the bundle.
export function floorPx(value: string): number | null {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (px) return Number(px[1]);
  const max = /^max\((.*)\)$/.exec(value);
  if (!max) return null;
  const floors = splitList(max[1])
    .map(floorPx)
    .filter((n): n is number => n !== null);
  return floors.length > 0 ? Math.max(...floors) : null;
}
