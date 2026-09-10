import { describe, it, expect } from "vitest";
import {
  RAIL_BIND_TABS,
  checkoutLabel,
  railBindChip,
  railBindChips,
  railBindFix,
  railBindTabAfterKey,
  type RailBindings,
} from "$lib/orchestration/railBind";

const UNBOUND: RailBindings = { worktreePath: null, branch: null, pageId: null };

describe("the tab strip", () => {
  it("is the four settings, in the order they take effect", () => {
    // The trigger leads because it is what STARTS the rail: the other
    // three describe the run it begins.
    expect(RAIL_BIND_TABS.map((t) => t.id)).toEqual(["trigger", "worktree", "branch", "page"]);
    expect(RAIL_BIND_TABS.map((t) => t.label)).toEqual(["Trigger", "Worktree", "Branch", "Page"]);
  });

  it("hands every tab a chip, so the strip can say the answers too", () => {
    const chips = railBindChips(UNBOUND, null);
    expect(chips.map((c) => c.tab)).toEqual(["trigger", "worktree", "branch", "page"]);
  });
});

describe("a checkout's short name", () => {
  it("is the folder, not the path that led to it", () => {
    expect(checkoutLabel("/Users/me/Coding/gavin-auth")).toBe("gavin-auth");
    expect(checkoutLabel("/Users/me/Coding/gavin-auth/")).toBe("gavin-auth");
  });

  it("leaves a path with no segments alone rather than emptying the chip", () => {
    // A chip that renders "" is a binding that looks unset. Better the
    // full oddity than a blank.
    expect(checkoutLabel("/")).toBe("/");
    expect(checkoutLabel("gavin")).toBe("gavin");
  });
});

describe("what a chip says", () => {
  it("names the default, not a blank, when a binding is unset", () => {
    const [trigger, worktree, branch, page] = railBindChips(UNBOUND, null);
    expect(trigger.value).toBe("starts by hand");
    expect(worktree.value).toBe("no worktree");
    expect(branch.value).toBe("any branch");
    expect(page.value).toBe("page at launch");
    // None of the four is an error: every one has a working default,
    // and colouring them as faults would put a warning on every new rail.
    expect([trigger.bound, worktree.bound, branch.bound, page.bound]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("names the condition a triggered rail waits on", () => {
    const all = railBindChip("trigger", { ...UNBOUND, trigger: { kind: "all-rails-done" } }, null);
    expect(all.value).toBe("after all rails");
    expect(all.bound).toBe(true);

    const named = railBindChip(
      "trigger",
      { ...UNBOUND, trigger: { kind: "rail-done", rail: "backend" } },
      null
    );
    expect(named.value).toContain("backend");
  });

  it("shows the folder but keeps the whole path in the tooltip", () => {
    const chip = railBindChip("worktree", { ...UNBOUND, worktreePath: "/w/gavin-auth" }, null);
    expect(chip.value).toBe("gavin-auth");
    expect(chip.bound).toBe(true);
    expect(chip.tip).toContain("/w/gavin-auth");
  });

  it("says what gavin will DO with a bound branch", () => {
    const chip = railBindChip("branch", { ...UNBOUND, branch: "auth" }, null);
    expect(chip.value).toBe("auth");
    expect(chip.tip).toContain("switches");
    expect(chip.tip).toContain("auth");
  });

  it("reads a closed page exactly as no page at all", () => {
    // Both end the same way: the next launch makes a new one. A chip
    // naming a page that is gone would send the human looking for it.
    const closed = railBindChip("page", { ...UNBOUND, pageId: "p-gone" }, null);
    expect(closed.value).toBe("page at launch");
    expect(closed.bound).toBe(false);
    const live = railBindChip("page", { ...UNBOUND, pageId: "p1" }, "Auth");
    expect(live.value).toBe("Auth");
    expect(live.bound).toBe(true);
  });

  it("treats a rail written before the branch field as unbound, not undefined", () => {
    const chip = railBindChip("branch", { worktreePath: null, pageId: null }, null);
    expect(chip.value).toBe("any branch");
    expect(chip.bound).toBe(false);
  });
});

describe("the conflict box's repair button", () => {
  it("lands on the branch list for a branch that is gone", () => {
    expect(railBindFix("branch-missing")).toEqual({
      tab: "branch",
      label: "Pick another branch…",
    });
  });

  it("lands on the worktree list for a worktree that is gone", () => {
    expect(railBindFix("worktree-missing").tab).toBe("worktree");
    expect(railBindFix("worktree-missing").label).toContain("worktree");
  });

  it("offers a rail with no binding at all a worktree", () => {
    expect(railBindFix("rail-unbound")).toEqual({
      tab: "worktree",
      label: "Give it a worktree…",
    });
  });
});

describe("arrow keys across the strip", () => {
  it("wrap in both directions", () => {
    expect(railBindTabAfterKey("worktree", "ArrowRight")).toBe("branch");
    expect(railBindTabAfterKey("page", "ArrowRight")).toBe("trigger");
    expect(railBindTabAfterKey("worktree", "ArrowLeft")).toBe("trigger");
    expect(railBindTabAfterKey("trigger", "ArrowLeft")).toBe("page");
  });

  it("jump to the ends", () => {
    expect(railBindTabAfterKey("branch", "Home")).toBe("trigger");
    expect(railBindTabAfterKey("branch", "End")).toBe("page");
  });

  it("claim nothing else — Escape has to keep reaching the modal stack", () => {
    for (const key of ["Escape", "Enter", " ", "ArrowUp", "Tab", "a"]) {
      expect(railBindTabAfterKey("branch", key)).toBeNull();
    }
  });
});
