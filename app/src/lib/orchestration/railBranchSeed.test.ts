import { describe, it, expect } from "vitest";
import { freeBranchNameFrom, validateBranchName } from "$lib/git/git";
import { svelteSources } from "$lib/sources";

// Both name fields a rail's bind dialog can open -- "New branch…" inline
// and the "New worktree…" fork dialog's branch input -- used to start
// empty, so the human retyped a name gavin already knew: the rail's.
// Seeding them is the behaviour, and neither an `$state` initialiser nor
// a prop hand-off is reachable from the pure suite, so this pins the
// wiring in the source the way orchestrationGroupLabel.test.ts does.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const BIND = "RailBindDialog.svelte";
const FORK = "GitForkDialog.svelte";

describe("the branch name a rail's bind dialog seeds", () => {
  it("is the rail's name, deduped against the repo's branches", () => {
    const s = source(BIND);
    expect(s).toContain(
      "const seedBranch = $derived(freeBranchNameFrom(rail.name, branches.map((b) => b.name)));"
    );
  });

  it("fills the inline New branch… field when that form opens", () => {
    const s = source(BIND);
    // Assigned by the opener, not by an $effect: re-seeding on every
    // open is what makes Cancel discard a half-typed name.
    // The opener also clears the last refusal between the two, which is
    // why this is not one unbroken sequence.
    expect(s).toMatch(/function startNaming\(\): void \{\s*draftBranch = seedBranch;[^}]*naming = true;/);
    expect(s).toContain("onclick={startNaming}");
    expect(s).not.toContain("onclick={() => (naming = true)}");
  });

  it("is handed to the New worktree… dialog, whose folder default follows it", () => {
    expect(source(BIND)).toContain("branchSeed={seedBranch}");
    const fork = source(FORK);
    expect(fork).toContain("let branch = $state(branchSeed);");
    // The folder still tracks the branch, so a seeded branch seeds the
    // folder too -- that link is the reason one seed is enough.
    expect(fork).toContain("if (!folderTouched && anchor) folder = effectiveBranch ? defaultWorktreePath(anchor, effectiveBranch)");
    // ...inside the workspace's own `.gavin-worktrees`, not the git root's.
    expect(fork).toContain("worktreesAnchor(gavinRoot, root)");
  });

  it("leaves the Git tab's own fork dialog unseeded", () => {
    // The switcher has no rail, so its branch field must keep opening
    // empty on its placeholder rather than inheriting a default.
    expect(source("GitWorktreeSwitcher.svelte")).not.toContain("branchSeed");
    expect(source(FORK)).toContain("branchSeed = \"\",");
  });
});

describe("the seed itself", () => {
  it("is a name both fields accept, for the rail names a human actually types", () => {
    const branches = ["main", "auth"];
    for (const railName of ["Auth", "Rail 1", "Feature/Auth", "UI polish!"]) {
      const seed = freeBranchNameFrom(railName, branches);
      expect(validateBranchName(seed)).toBeNull();
      expect(branches).not.toContain(seed);
    }
  });
});
