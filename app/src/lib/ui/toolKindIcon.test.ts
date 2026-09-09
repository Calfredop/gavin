import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import type { Component } from "svelte";
import { toolIcon, toolKindIcon } from "$lib/ui/toolKindIcon";
import { TOOL_KINDS, type ToolKind } from "$lib/orchestrationTools";

/// The rendered lucide class of any glyph. The kind-keyed helper below
/// is the one the original cases use; this is the same question asked of
/// a component the caller already has.
function classOf(icon: Component<{ size?: number }>, label: string): string {
  const body = render(icon, { props: { size: 13 } }).body;
  const classes = [...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  const named = classes.filter((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  expect(named.length, `${label} rendered no lucide-<name> class`).toBeGreaterThan(0);
  return named[named.length - 1];
}

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

// The tool's OWN icon (v33). Six `command` tools on one rail were six
// identical terminals: the kind lookup above is a good answer to "what
// is this made of" and no answer at all to "which one is this".
describe("a tool's own icon", () => {
  it("draws the icon its author picked", () => {
    expect(classOf(toolIcon({ kind: "command", icon: "rocket" }), "rocket")).toBe("lucide-rocket");
  });

  // The two absences that mean the same thing -- a tool authored before
  // v33, and one whose icon was cleared -- and the reason `toolIcon`
  // takes the whole tool rather than the name: the kind is the fallback,
  // so it has to be in the same call.
  it("falls back to the kind when nothing was picked", () => {
    expect(toolIcon({ kind: "agent", icon: null })).toBe(toolKindIcon("agent"));
    expect(toolIcon({ kind: "review", icon: undefined })).toBe(toolKindIcon("review"));
    expect(toolIcon({ kind: "until", icon: "" })).toBe(toolKindIcon("until"));
  });

  // Skew in both directions: an icon a NEWER gavin offered, and one this
  // library no longer has. The kind's glyph is what the tool drew before
  // anybody picked, which is a real answer where a question mark is not
  // -- and `toRecord` keeps the stored name, so the choice comes back on
  // a build that can draw it.
  it("falls back to the kind for a name it cannot resolve", () => {
    expect(toolIcon({ kind: "script", icon: "teleporter" })).toBe(toolKindIcon("script"));
  });

  // The picked icon wins over the kind, which is the whole point: a
  // `pr` tool made a rocket draws a rocket, not a pull request.
  it("prefers the picked icon to the kind's own", () => {
    expect(toolIcon({ kind: "pr", icon: "rocket" })).not.toBe(toolKindIcon("pr"));
  });
});
