import { describe, it, expect } from "vitest";
import {
  classifyWorktrees,
  deleteBranchesLabel,
  mayForceRemoval,
  nothingToSweepLines,
  staleWorktrees,
  sweepConfirm,
  type SweepFacts,
} from "./worktreeSweep";
import type { FileEntry, WorktreeInfo } from "./git";

function wt(path: string, branch: string | null, extra: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return { path, head: "abc1234", branch, isMain: false, locked: false, prunable: false, ...extra };
}

const MAIN = wt("/repo", "main", { isMain: true });

function facts(over: Partial<SweepFacts> = {}): SweepFacts {
  return {
    base: "main",
    merged: new Set(["main"]),
    dirty: new Set(),
    rails: [],
    sessionCwds: [],
    ...over,
  };
}

/// The whole point of the button: a fork whose branch landed, with
/// nothing left running in it, is safe to delete.
describe("a worktree with every reason to keep it ruled out", () => {
  it("is stale, and says which merge made it so", () => {
    const stale = staleWorktrees(
      [MAIN, wt("/repo-auth", "feat/auth")],
      facts({ merged: new Set(["main", "feat/auth"]) })
    );
    expect(stale.map((v) => v.path)).toEqual(["/repo-auth"]);
    expect(stale[0].reason).toBe("feat/auth is merged into main");
    expect(stale[0].blocker).toBeNull();
  });

  it("measures against the workspace's own trunk, not the word main", () => {
    const stale = staleWorktrees(
      [wt("/repo", "develop", { isMain: true }), wt("/repo-auth", "feat/auth")],
      facts({ base: "develop", merged: new Set(["develop", "feat/auth"]) })
    );
    expect(stale[0].reason).toBe("feat/auth is merged into develop");
  });
});

// One test per disqualifier -- these four ARE the rule, and each of them
// is a folder someone would have lost.
describe("the four disqualifiers", () => {
  const trees = [MAIN, wt("/repo-auth", "feat/auth")];
  const merged = new Set(["main", "feat/auth"]);

  it("keeps a worktree whose branch has not landed", () => {
    const [, fork] = classifyWorktrees(trees, facts({ merged: new Set(["main"]) }));
    expect(fork.stale).toBe(false);
    expect(fork.blocker).toBe("unmerged");
    expect(fork.reason).toBe("feat/auth is not merged into main");
  });

  it("keeps a worktree a rail is bound to, and names the rail", () => {
    const [, fork] = classifyWorktrees(
      trees,
      facts({ merged, rails: [{ name: "auth", worktreePath: "/repo-auth" }] })
    );
    expect(fork.blocker).toBe("rail");
    expect(fork.reason).toBe("rail “auth” bound to it");
  });

  it("keeps a worktree a live session sits in, however deep", () => {
    const [, fork] = classifyWorktrees(
      trees,
      facts({ merged, sessionCwds: ["/repo-auth/app/src/lib"] })
    );
    expect(fork.blocker).toBe("session");
    expect(fork.reason).toBe("a session is open in it");
  });

  it("keeps a worktree with uncommitted changes", () => {
    const [, fork] = classifyWorktrees(trees, facts({ merged, dirty: new Set(["/repo-auth"]) }));
    expect(fork.blocker).toBe("dirty");
    expect(fork.reason).toBe("uncommitted changes");
  });

  // The rule the card states outright: uncommitted work outranks every
  // other fact, because it is the only one that is not recoverable.
  it("reports the uncommitted changes first when several disqualifiers hold", () => {
    const [, fork] = classifyWorktrees(
      trees,
      facts({
        merged: new Set(["main"]),
        dirty: new Set(["/repo-auth"]),
        rails: [{ name: "auth", worktreePath: "/repo-auth" }],
        sessionCwds: ["/repo-auth"],
      })
    );
    expect(fork.blocker).toBe("dirty");
  });
});

describe("rows that were never candidates", () => {
  it("never sweeps the main checkout, however clean and merged it is", () => {
    const [main] = classifyWorktrees([MAIN], facts());
    expect(main.stale).toBe(false);
    expect(main.blocker).toBe("main");
  });

  it("leaves a vanished worktree to Prune", () => {
    const [, gone] = classifyWorktrees(
      [MAIN, wt("/repo-auth", "feat/auth", { prunable: true })],
      facts({ merged: new Set(["main", "feat/auth"]) })
    );
    expect(gone.blocker).toBe("missing");
  });

  it("respects a lock", () => {
    const [, locked] = classifyWorktrees(
      [MAIN, wt("/repo-auth", "feat/auth", { locked: true })],
      facts({ merged: new Set(["main", "feat/auth"]) })
    );
    expect(locked.blocker).toBe("locked");
  });

  it("cannot judge a detached HEAD, so keeps it", () => {
    const [, detached] = classifyWorktrees([MAIN, wt("/repo-spike", null)], facts());
    expect(detached.blocker).toBe("detached");
  });
});

// Paths reach this module from three sources that disagree about the
// trailing slash, and from a fork dialog that takes any path typed into
// it.
describe("path matching", () => {
  it("ignores trailing slashes on either side", () => {
    const [, fork] = classifyWorktrees(
      [MAIN, wt("/repo-auth/", "feat/auth")],
      facts({ merged: new Set(["main", "feat/auth"]), sessionCwds: ["/repo-auth"] })
    );
    expect(fork.blocker).toBe("session");
  });

  it("does not let a sibling with a shared prefix stand in", () => {
    const stale = staleWorktrees(
      [MAIN, wt("/repo-auth", "feat/auth")],
      facts({ merged: new Set(["main", "feat/auth"]), sessionCwds: ["/repo-authz/src"] })
    );
    expect(stale.map((v) => v.path)).toEqual(["/repo-auth"]);
  });

  // A nested worktree's session belongs to the nested worktree, not to
  // the checkout it happens to sit inside.
  it("hands a session to the deepest worktree containing it", () => {
    const verdicts = classifyWorktrees(
      [MAIN, wt("/repo/.worktrees/auth", "feat/auth")],
      facts({ merged: new Set(["main", "feat/auth"]), sessionCwds: ["/repo/.worktrees/auth/app"] })
    );
    expect(verdicts[1].blocker).toBe("session");
  });

  it("hands a rail bound below a worktree to that worktree", () => {
    const [, fork] = classifyWorktrees(
      [MAIN, wt("/repo-auth", "feat/auth")],
      facts({
        merged: new Set(["main", "feat/auth"]),
        rails: [{ name: "auth", worktreePath: "/repo-auth/app" }],
      })
    );
    expect(fork.blocker).toBe("rail");
  });

  it("ignores a rail bound outside every worktree of this repo", () => {
    const stale = staleWorktrees(
      [MAIN, wt("/repo-auth", "feat/auth")],
      facts({
        merged: new Set(["main", "feat/auth"]),
        rails: [{ name: "elsewhere", worktreePath: "/some/other/repo" }],
      })
    );
    expect(stale).toHaveLength(1);
  });
});

describe("the confirmation", () => {
  const stale = staleWorktrees(
    [MAIN, wt("/work/repo-auth", "feat/auth"), wt("/work/repo-ui", "feat/ui")],
    facts({ merged: new Set(["main", "feat/auth", "feat/ui"]) })
  );

  it("names the action on its button and counts what it removes", () => {
    const confirm = sweepConfirm(stale, "main");
    expect(confirm.title).toBe("Remove 2 stale worktrees?");
    expect(confirm.confirmLabel).toBe("Remove 2 worktrees");
    expect(confirm.danger).toBe(true);
  });

  it("says one worktree in the singular", () => {
    const confirm = sweepConfirm(stale.slice(0, 1), "main");
    expect(confirm.title).toBe("Remove 1 stale worktree?");
    expect(confirm.confirmLabel).toBe("Remove 1 worktree");
  });

  it("lists every folder it will delete, with the reason it qualified", () => {
    expect(sweepConfirm(stale, "main").lines).toEqual([
      "repo-auth — feat/auth is merged into main",
      "repo-ui — feat/ui is merged into main",
      "Their folders are deleted. The commits stay reachable on main.",
    ]);
  });

  it("offers the branch deletion in the same prompt, ticked", () => {
    const check = sweepConfirm(stale, "main").check;
    expect(check).toEqual({ label: "Also delete the 2 merged branches", default: true });
  });

  it("names the branch outright when there is only one", () => {
    expect(deleteBranchesLabel(stale.slice(0, 1))).toBe("Also delete the branch feat/auth");
  });
});

describe("when nothing is stale", () => {
  it("says why each worktree was kept rather than nothing at all", () => {
    const verdicts = classifyWorktrees(
      [MAIN, wt("/repo-auth", "feat/auth")],
      facts({ dirty: new Set(["/repo-auth"]) })
    );
    expect(nothingToSweepLines(verdicts)).toEqual(["repo-auth — uncommitted changes"]);
  });

  it("says so plainly when the repo has no linked worktrees", () => {
    expect(nothingToSweepLines(classifyWorktrees([MAIN], facts()))).toEqual([
      "This repo has no linked worktrees.",
    ]);
  });
});

describe("whether a removal may be forced", () => {
  const entry = (path: string): FileEntry => ({ path, status: "?" });

  it("refuses on a checkout git could not be read for", () => {
    // The same direction sweepFacts takes: unknown counts against the
    // deletion, never for it.
    expect(mayForceRemoval(null)).toBe(false);
  });

  it("refuses on a clean checkout — nothing is in the way to force past", () => {
    expect(mayForceRemoval({ staged: [], unstaged: [] })).toBe(false);
  });

  it("allows it when everything left is gavin's own", () => {
    expect(
      mayForceRemoval({ staged: [], unstaged: [entry(".gavin-root")] })
    ).toBe(true);
    expect(
      mayForceRemoval({
        staged: [entry(".gavin-root/PRD.md")],
        unstaged: [entry(".gavin-root/plans/a.md"), entry("apps/web/.gavin/plans/b.md")],
      })
    ).toBe(true);
  });

  it("refuses the moment one entry is the human's", () => {
    // The whole guard: `--force` past gavin's own board is a link and a
    // folder gavin made, `--force` past this is an hour of someone's work.
    expect(
      mayForceRemoval({
        staged: [],
        unstaged: [entry(".gavin-root"), entry("src/newfile.ts")],
      })
    ).toBe(false);
  });
});
