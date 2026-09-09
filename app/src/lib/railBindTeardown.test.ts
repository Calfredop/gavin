import { describe, it, expect } from "vitest";
import { railSelection, type RailLike } from "./railSelection.svelte";
import { svelteSources } from "./sources";

// Creating a worktree from a rail's bind dialog cut the worktree and then
// bound nothing: the button looked dead while `git worktree add` quietly
// piled up `…-2`, `…-3` checkouts nobody was attached to.
//
// The cause is a teardown race with a shape this app can repeat anywhere.
// `OrchestrationHubView` selects the dialog's rail with a `{@const}` that
// looks the rail up by `binding`, and hands it down as `rail` — so the
// prop resolves THROUGH the state `onClose` clears. The fork dialog's
// callbacks deliberately run after that close (the dialog must not hang
// on a save round trip), and `rail.id` there is read from a derived that
// has just been told its answer changed.
//
// The first half of this file is that mechanism on Svelte's own runes,
// so the fix cannot be argued away as a guess; the second pins the shape
// of the fix in the source, the way railBranchSeed.test.ts does, since a
// prop hand-off is not reachable from the pure suite.

describe("a prop read through the state that closed the dialog", () => {
  it("is undefined once that state is cleared, exactly as at teardown", () => {
    const rails = [{ id: "rail-1", name: "Implementations" }];
    const selection = railSelection(rails, "rail-1");

    // Captured while the dialog is open — what the fix does.
    const railId = selection.rail?.id;
    expect(railId).toBe("rail-1");

    selection.close(); // onClose()

    // Same read, one statement later, and there is nothing there. This is
    // the TypeError that `void submit()` swallowed.
    expect(selection.rail).toBeUndefined();
    expect(() => (selection.rail as RailLike).id).toThrow(TypeError);
    // The snapshot still answers, which is the whole point.
    expect(railId).toBe("rail-1");
  });
});

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const BIND = "RailBindDialog.svelte";
const HUB = "OrchestrationHubView.svelte";

describe("the rail a bind dialog acts on", () => {
  it("is snapshotted at mount, not re-read from the prop", () => {
    expect(source(BIND)).toContain("const railId = rail.id;");
  });

  it("is never re-read from the prop by an action", () => {
    const s = source(BIND);
    // Any `rail.id` reaching an action is a read that a close can beat.
    expect(s).not.toMatch(/bindRailAction\([^)]*rail\.id/);
    expect(s).not.toMatch(/runOnRailPage\([^)]*rail\.id/);
  });

  it("carries the fork dialog's post-close callbacks", () => {
    const s = source(BIND);
    // Both run after the dialog has been told to close: the binding
    // itself, and the setup session opened for a workspace that declares
    // `[worktree] setup`.
    expect(s).toContain("await bindRailAction(workspaceId, railId, { worktreePath: path });");
    expect(s).toContain("void runOnRailPage(workspaceId, railId, path, command)");
  });

  it("still reads the rail's NAME live, so a rename redraws the dialog", () => {
    const s = source(BIND);
    expect(s).toContain("rail.name");
  });
});

describe("the hub view that selects it", () => {
  it("resolves the rail through the same state its onClose clears", () => {
    // The premise of the snapshot above. If this ever stops being true --
    // the hub holding the rail itself rather than looking it up by id --
    // the capture becomes belt-and-braces rather than the fix.
    const s = source(HUB);
    expect(s).toContain("{@const bindingRail = orch.rails.find((r) => r.id === binding)}");
    expect(s).toContain("onClose={() => (binding = null)}");
  });
});
