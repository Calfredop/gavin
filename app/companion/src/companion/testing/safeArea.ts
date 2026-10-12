// What a phone on its side needs of the stylesheets, for the guards that
// hold it in the bundle and in the hub (seam/landscape.test.ts, the
// shell's surfaces/landscape.test.ts). The suites have no page to lay
// out, so what a guard can hold is what the rules say.
import { rulesOf, splitList, type StyleRule } from "$companion/testing/styleRules";

/// A rule, and the source it is in.
export interface PlacedRule extends StyleRule {
  file: string;
}

/// The rules of every `<style>` block in these sources.
export function componentRules(sources: Record<string, string>): PlacedRule[] {
  return Object.entries(sources).flatMap(([file, text]) =>
    [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].flatMap((m) =>
      rulesOf(m[1]).map((rule) => ({ ...rule, file }))
    )
  );
}

/// The four sides of a `padding` shorthand, top, right, bottom, left.
export function paddingSides(value: string): [string, string, string, string] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  const text = value.trim();
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === undefined || /\s/.test(ch)) && depth === 0) {
      if (i > from) parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  const [top, right = top, bottom = top, left = right] = parts;
  return [top, right, bottom, left];
}

const SIDE_INSET = /safe-area-inset-(left|right)/;

/// Whether a rule reads a side inset anywhere in its declarations.
export function readsSideInset(rule: StyleRule): boolean {
  return [...rule.declarations.values()].some((value) => SIDE_INSET.test(value));
}

/// Whether a rule's padding keeps clear of both side insets: its right
/// side reads the right inset and its left side the left.
export function padsBothSides(rule: StyleRule): boolean {
  const padding = rule.declarations.get("padding");
  if (!padding) return false;
  const [, right, , left] = paddingSides(padding);
  return right.includes("env(safe-area-inset-right") && left.includes("env(safe-area-inset-left");
}

export interface Viewport {
  width: number;
  height: number;
}

/// Whether a media query's conditions hold on a viewport. Only what the
/// phone's queries say: `and` between `orientation` and the width and
/// height bounds, in px.
export function matchesMedia(query: string, viewport: Viewport): boolean {
  const text = query.replace(/^@media\s+/, "").trim();
  return splitList(text).some((alternative) =>
    alternative.split(/\s+and\s+/).every((feature) => {
      const m = /^\(\s*([a-z-]+)\s*:\s*([a-z0-9.]+)\s*\)$/.exec(feature.trim());
      if (!m) throw new Error(`a media feature this reader does not know: ${feature}`);
      const [, name, value] = m;
      const px = Number.parseFloat(value);
      switch (name) {
        case "orientation":
          return (viewport.width > viewport.height ? "landscape" : "portrait") === value;
        case "max-height":
          return viewport.height <= px;
        case "min-height":
          return viewport.height >= px;
        case "max-width":
          return viewport.width <= px;
        case "min-width":
          return viewport.width >= px;
        default:
          throw new Error(`a media feature this reader does not know: ${name}`);
      }
    })
  );
}
