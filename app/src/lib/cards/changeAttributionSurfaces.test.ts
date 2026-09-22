import { describe, it, expect } from "vitest";
import { allSources } from "$lib/sources";

// TypeSafe change attribution is one pure module read on three surfaces
// -- the per-run Changes view, its discard prompt and the Review tab's
// grouping -- behind one switch in Settings and one host command, and
// nothing links those files. Every rule they share is invisible to the
// suites: a chip nobody renders, a summary that never learns the count,
// a discard prompt that still cannot name what goes, a toggle that
// writes a setting the host never reads. Reads sources rather than the
// rendered DOM, following runChangesSurfaces.test.ts.

const SOURCES = allSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the switch", () => {
  it("is its own setting, off by default, and the host is asked through its own command", () => {
    const backend = source("backend.ts");
    expect(backend).toContain('invoke("set_typesafe_change_attribution", { enabled })');
    expect(backend).toContain('invoke("typesafe_attribution", { request })');
    // The panel is told the switch's state beside the verdict's, never
    // the key.
    expect(backend).toContain(
      "typesafeSettings(): Promise<{ enabled: boolean; hasKey: boolean; changeAttribution: boolean }>"
    );
    expect(source("turnVerdictState.ts")).toContain("changeAttribution: boolean;");
  });

  it("has its own toggle in the TypeSafe section, and the copy says what is sent and where", () => {
    const s = source("GlobalSettingsView.svelte");
    expect(s).toContain("<h3>TypeSafe</h3>");
    expect(s).toContain("checked={$typesafeSettings?.changeAttribution ?? false}");
    expect(s).toContain("Change attribution");
    // What leaves the machine: source code and card text, not a screen.
    expect(s).toContain("diff excerpt");
    expect(s).toContain("card titles and bodies");
    expect(s).toContain("70 changed lines");
    expect(s).toMatch(/other cards? (has|have)\s+run in the same checkout/);
    // It does not ride on the turn verdict's switch.
    expect(s).toContain("A separate switch");
  });
});

describe("the per-run Changes view", () => {
  const MODAL = "RunChangesModal.svelte";

  it("asks for attribution when the run loads and reads it back by the run's key", () => {
    expect(source("runChangesState.ts")).toContain("attributeRun(");
    expect(source(MODAL)).toContain("attributionKey(path, baseSha, null)");
  });

  it("chips a file that looks like another card's with that card's title", () => {
    const modal = source(MODAL);
    expect(modal).toContain("foreignFiles(");
    expect(modal).toContain("note={");
    expect(source("GitFileRow.svelte")).toContain("{#if note}");
  });

  it("counts them in the summary and names them in the discard prompt", () => {
    const modal = source(MODAL);
    expect(modal).toContain("changesSummary(changes, foreignCount)");
    expect(modal).toContain("discardPrompt(changes, title, foreign.map(foreignLine))");
  });
});

describe("the Review tab", () => {
  it("hands each card's owners to the grouper and asks for attribution once the files land", () => {
    expect(source("ReviewHubView.svelte")).toContain("owners: ownersOf(");
    expect(source("reviewState.ts")).toContain("attributeRun(");
  });

  it("groups on claimed files and says when a collision was set aside", () => {
    const board = source("reviewBoard.ts");
    expect(board).toContain("claimedFiles(candidate)");
    expect(board).toContain("not counted as collisions");
  });
});

describe("the rules", () => {
  it("never removes a file from the list and never reaches the discard itself", () => {
    // The reset is the whole worktree, and attribution has no say in it:
    // `discardRun` takes the untracked list from the changes, not from
    // any attribution.
    const state = source("runChangesState.ts");
    expect(state).toContain("const untracked = untrackedPaths(view.changes);");
    expect(state).not.toMatch(/gitDiscardRun\([^)]*attribution/);
  });

  it("pins the model and keeps the question verbatim", () => {
    const module = source("changeAttribution.ts");
    expect(module).toContain('import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict"');
    expect(source("turnVerdict.ts")).toContain('export const TYPESAFE_MODEL = "jev-1.13.0"');
    expect(module).toContain(
      "`change` is one modified file from a git working tree in which several tasks are being worked on at the same time."
    );
  });
});
