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
    // And the three that cannot run still need a glyph, or they draw as
    // scripts.
    for (const kind of ["gavin", "until", "pr"]) {
      expect(tab, kind).toContain(`kind === "${kind}"`);
    }
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
