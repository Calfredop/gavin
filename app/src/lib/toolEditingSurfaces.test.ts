import { describe, it, expect } from "vitest";

// Tool editing is one editor reached from two places -- the Orchestration
// tab's drawer and the Tools hub tab -- and nothing in the type system
// links them. Both of the rules that make it ONE editor are invisible to
// every other suite: a Tools tab that built its own draft would render
// perfectly and save a tool the library never sees, and a dialog whose
// `initialEdit` reached no state would open on its list with the row the
// human pressed nowhere in sight.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts: mounting a modal to assert "this handler is
// called" tests the harness more than the wiring.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const TAB = "WorkspaceToolsHubView.svelte";
const DIALOG = "ToolLibraryDialog.svelte";

describe("editing a tool from the Tools tab", () => {
  it("opens the library's own dialog rather than a second editor", () => {
    const tab = source(TAB);
    expect(tab).toContain("import ToolLibraryDialog");
    // One library, one editor, one store. A second form here would drift
    // from this one the first time either grew a field.
    expect(tab).not.toContain("saveToolAction");
    expect(tab).not.toContain("validateTool");
  });

  it("seeds the dialog on the row that was pressed", () => {
    expect(source(TAB)).toContain("initialEdit={managing.draft}");
    expect(source(DIALOG)).toMatch(/initialEdit\?: Tool \| null;/);
  });

  it("builds that draft with the shared rule, not by hand", () => {
    // editDraftFor is what turns a built-in row into a saveable copy. A
    // draft assembled here would hand the dialog a `scope: "builtin"`
    // tool, and saveToolAction refuses those -- after the human typed.
    expect(source(TAB)).toContain("editDraftFor(tool, crypto.randomUUID())");
  });

  it("reaches the draft state, so the form opens on it", () => {
    // The seeding is at CONSTRUCTION, not in an effect: an effect that
    // re-ran would overwrite what the human had typed with the draft
    // they started from.
    const dialog = source(DIALOG);
    expect(dialog).toMatch(/let editing = \$state<Tool \| null>\(\s*initialEdit \?/);
  });

  it("offers Duplicate on a built-in row and Edit on the rest", () => {
    const tab = source(TAB);
    expect(tab).toContain('{#if tool.scope === "builtin"}');
    expect(tab).toContain('label="Duplicate to edit"');
    expect(tab).toContain('label="Edit"');
  });

  it("lists every kind, so switching one does not make its row vanish", () => {
    const tab = source(TAB);
    expect(tab).toContain("listedTools(library)");
    expect(tab).not.toContain("runnableTools(");
    // And the kinds that cannot run still need a glyph, or they draw as
    // scripts. One lookup rather than a ternary here since 2026-09-07;
    // its own coverage is ui/toolKindIcon.test.ts. `toolIcon` since v33,
    // which resolves the tool's own icon before falling back to it.
    expect(tab).toContain("toolIcon");
  });
});

describe("switching a tool's kind", () => {
  it("goes through bodyForKind, never straight onto the draft", () => {
    // A raw `editing.kind = kind` leaves a prompt behind as a `pr` tool's
    // body, or an action-less body on a `gavin` one -- which stalls every
    // step it is dropped onto, discoverable only at launch.
    const dialog = source(DIALOG);
    expect(dialog).toContain("onclick={() => pickKind(kind)}");
    expect(dialog).toContain("editing.body = bodyForKind(kind, editing.body, stashedBody)");
  });

  it("hides the working directory on the kinds that never read it", () => {
    // A rail step runs in the rail's own checkout (spec T6/T11), so on a
    // kind that only runs as a step the field has no effect at all — and
    // one that quietly kept a value would be read as having one.
    expect(source(DIALOG)).toContain("{#if isRunnableStandalone(editing)}");
  });
});

// The icon picker (v33). Its rules are the ones no other suite can see:
// the pure half is ui/iconLibrary.test.ts, and what is left is where the
// field SITS and whether it is gated.
describe("picking a tool's icon", () => {
  it("offers the app's icon library rather than a list of its own", () => {
    const dialog = source(DIALOG);
    expect(dialog).toContain('from "./ui/iconLibrary"');
    // Grid cells come from the library's own groups. A hand-written list
    // here would be a second vocabulary, drifting from the one
    // `iconByName` resolves a STORED name against — and a name that
    // resolves nowhere draws as the tool's kind, silently.
    expect(dialog).toContain("searchIcons(iconQuery)");
    expect(dialog).toContain("{#each group.icons as entry (entry.name)}");
  });

  it("puts the field on the form both New tool and Edit tool draw", () => {
    // One form, two headers — so a tool can be given an icon while it is
    // being written rather than only on a second pass through Edit. The
    // field sits after that shared header, which is what makes it part
    // of the form rather than of the list.
    const dialog = source(DIALOG);
    const header = dialog.indexOf('"Edit tool" : "New tool"');
    const field = dialog.indexOf('class="icon-field"');
    expect(header, "the shared form header moved").toBeGreaterThan(-1);
    expect(field, "the icon field is not in the form").toBeGreaterThan(header);
  });

  it("is gated on the daemon that would store it", () => {
    // The third widening of SaveTool's record, and the same silent drop
    // `toolCwd` gates: a v32 daemon takes the save, drops the name and
    // hands the tool back wearing its kind's glyph. An icon is purely
    // cosmetic, so there is no second symptom later — it would simply
    // never appear.
    const dialog = source(DIALOG);
    expect(dialog).toContain('featureBlockedReason($daemonCompat, "toolIcon")');
    expect(dialog).toContain("use:tooltip={iconBlocked}");
    expect(dialog).toContain("disabled={Boolean(iconBlocked)}");
  });

  it("offers a way back to the kind's own icon", () => {
    // Picking is one click and un-picking has to be too. Without it the
    // only route back from a wrong glyph is deleting the tool, because
    // no cell in the grid means "none".
    expect(source(DIALOG)).toContain("function clearIcon()");
    expect(source(DIALOG)).toContain("editing.icon = null");
  });
});
