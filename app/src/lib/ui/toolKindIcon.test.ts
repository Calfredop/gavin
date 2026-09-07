import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import { toolKindIcon } from "./toolKindIcon";
import { TOOL_KINDS, type ToolKind } from "../orchestrationTools";

/// The rendered lucide class of a glyph -- the only stable identity an
/// icon component has from the outside. Borrowed from indicators.test.ts,
/// which asks the same question of the badge vocabulary.
function glyphClass(kind: ToolKind): string {
  const body = render(toolKindIcon(kind), { props: { size: 13 } }).body;
  const classes = [...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  const named = classes.filter((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  expect(named.length, `${kind} rendered no lucide-<name> class`).toBeGreaterThan(0);
  return named[named.length - 1];
}

// This lookup replaced four hand-written ternaries -- the drawer, the
// library dialog, the Tools tab and the rail's step chip each had one --
// and every one of them ended in a bare `: FileCode2`. A kind added to
// the type and forgotten in a file therefore rendered as a script, with
// nothing failing. These are the two invariants that were unassertable
// while the answer lived in four templates.
describe("the tool kind icons", () => {
  it("gives every authorable kind a glyph", () => {
    for (const kind of TOOL_KINDS) expect(toolKindIcon(kind)).toBeTruthy();
  });

  // A list is a column of names beside a column of glyphs. Two kinds
  // sharing one make the glyph column decoration rather than
  // information, which is precisely what the old default did.
  it("draws no two kinds the same", () => {
    const seen = new Map<string, ToolKind>();
    for (const kind of TOOL_KINDS) {
      const glyph = glyphClass(kind);
      expect(seen.get(glyph), `${kind} and ${seen.get(glyph)} share ${glyph}`).toBeUndefined();
      seen.set(glyph, kind);
    }
  });

  // The identity each kind is recognised by across four surfaces, and
  // the assertion the three orchestration surfaces suites used to make
  // one arm at a time in their own ternaries. Written out rather than
  // derived, so changing a glyph is a decision somebody made here.
  it("keeps the glyph each kind is recognised by", () => {
    const named: Array<[ToolKind, string]> = [
      ["agent", "lucide-bot"],
      ["command", "lucide-terminal"],
      ["script", "lucide-file-code-corner"],
      ["gavin", "lucide-zap"],
      ["until", "lucide-repeat"],
      ["pr", "lucide-git-pull-request"],
      // Somebody looking, which is what the step IS -- and the same
      // reading as the badge a running review step wears
      // (reviewWaitIndicator).
      ["review", "lucide-eye"],
    ];
    for (const [kind, glyph] of named) expect(glyphClass(kind), kind).toBe(glyph);
  });

  // A kind written by a NEWER gavin arrives as a string this build has
  // no entry for. A script icon is the honest fallback -- it is what the
  // four ternaries all defaulted to -- and it beats rendering nothing at
  // all beside a name.
  it("falls back rather than rendering nothing for a kind it does not know", () => {
    expect(toolKindIcon("teleport" as ToolKind)).toBe(toolKindIcon("script"));
  });
});
