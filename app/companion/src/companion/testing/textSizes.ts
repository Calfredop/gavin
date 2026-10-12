// Reading the text sizes a phone draws, for the guards that hold that the
// phone's text size reaches them (seam/textScale.test.ts, and the hub's
// own in the shell). A size moves with the root's `--text-scale` only if
// it is written against the root -- `rem`, or `em` through the body; one
// in `px` stays where it is.
import { codeOf } from "$companion/testing/companionSources";

/// Every text size a source sets: in its stylesheet, and on an element.
/// A stylesheet is passed as its own text, a component whole.
export function sizesIn(path: string, text: string): string[] {
  const style = (path.endsWith(".css") ? text : (text.match(/<style[\s\S]*?<\/style>/g) ?? []).join("\n")).replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );
  const markup = path.endsWith(".css") ? "" : codeOf(text.replace(/<style[\s\S]*?<\/style>/g, ""));
  const sizes: string[] = [];
  for (const [, value] of style.matchAll(/(?:^|[\s;{])font(?:-size)?\s*:\s*([^;}]+)/g)) sizes.push(value.trim());
  for (const [, value] of markup.matchAll(/font-size\s*[:=]\s*["{]?([^;"}]+)/g)) sizes.push(value.trim());
  return sizes;
}

/// A size that moves with the root: no px in it, a px floor under a
/// relative size (a field's 16px, under which iOS zooms), or the scale
/// itself.
export function scales(declared: string): boolean {
  const value = declared.replace(/\s*!important$/, "");
  if (!/\dpx/.test(value)) return true;
  if (/^max\(\s*\d+(\.\d+)?px\s*,\s*\d*\.?\d+(r?em|%)\s*\)$/.test(value)) return true;
  return value.includes("var(--text-scale");
}

/// Each size in px that does not move with the text, as `path: value`.
export function fixedSizes(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .flatMap(([path, text]) => sizesIn(path, text).filter((value) => !scales(value)).map((value) => `${path}: ${value}`))
    .sort();
}
