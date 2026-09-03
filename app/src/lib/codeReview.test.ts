import { describe, it, expect } from "vitest";
import {
  gavinDirFor,
  reviewRulesPath,
  plansFolderPath,
  REVIEW_RULES_LABEL,
  REVIEW_RULES_STARTER,
  defaultReviewBase,
  composeReviewPrompt,
  reviewBlocker,
} from "./codeReview";
import type { BranchInfo } from "./git";

function branch(name: string, over: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    current: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    sha: "abc1234",
    subject: "a commit",
    ...over,
  };
}

const BASE_OPTIONS = {
  base: "main",
  rulesPath: "/repo/.gavin-root/REVIEW.md",
  contextFolder: "/repo",
  plansFolder: "/repo/.gavin-root/plans",
};

describe("the rules file's location", () => {
  it("is the root context's marker directory", () => {
    expect(gavinDirFor("root")).toBe(".gavin-root");
    expect(gavinDirFor("context")).toBe(".gavin");
    expect(reviewRulesPath("/repo")).toBe("/repo/.gavin-root/REVIEW.md");
  });

  it("tolerates a folder handed over with a trailing slash", () => {
    expect(reviewRulesPath("/repo/")).toBe("/repo/.gavin-root/REVIEW.md");
    expect(plansFolderPath("/repo/lib/", "context")).toBe("/repo/lib/.gavin/plans");
  });

  it("names a nested context's own plans folder", () => {
    expect(plansFolderPath("/repo", "root")).toBe("/repo/.gavin-root/plans");
    expect(plansFolderPath("/repo/lib", "context")).toBe("/repo/lib/.gavin/plans");
  });

  it("labels the file the way a human would go looking for it", () => {
    expect(REVIEW_RULES_LABEL).toBe(".gavin-root/REVIEW.md");
  });
});

describe("REVIEW_RULES_STARTER", () => {
  // The starter ships headings and no rules on purpose: a default rule
  // would review every workspace against gavin's habits while reading as
  // though someone had chosen it.
  it("carries no rule of its own", () => {
    const bullets = REVIEW_RULES_STARTER.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeGreaterThan(0);
    for (const b of bullets) expect(b).toMatch(/^- \(e\.g\./);
  });

  it("says what makes a rule usable", () => {
    expect(REVIEW_RULES_STARTER).toContain("FAIL a review");
  });
});

describe("defaultReviewBase", () => {
  it("prefers the conventional trunk", () => {
    expect(defaultReviewBase([branch("feature", { current: true }), branch("main")])).toBe("main");
    expect(defaultReviewBase([branch("feature", { current: true }), branch("master")])).toBe(
      "master"
    );
  });

  it("prefers main over the other trunk names", () => {
    const branches = [branch("topic", { current: true }), branch("develop"), branch("main")];
    expect(defaultReviewBase(branches)).toBe("main");
  });

  // Reviewing a branch against ITSELF has an empty diff, and "no
  // findings" would then be indistinguishable from a clean review.
  it("falls back to the upstream when we are standing on the trunk", () => {
    const branches = [branch("main", { current: true, upstream: "origin/main" })];
    expect(defaultReviewBase(branches)).toBe("origin/main");
  });

  it("falls back to the caller's default when there is nothing else", () => {
    expect(defaultReviewBase([branch("solo", { current: true })])).toBe("main");
    expect(defaultReviewBase([], "trunk")).toBe("trunk");
  });
});

describe("composeReviewPrompt", () => {
  it("names the tab first, like every other launched agent", () => {
    expect(composeReviewPrompt(BASE_OPTIONS).startsWith("First, before anything else")).toBe(true);
  });

  it("reviews the branch against the given base and forbids changes", () => {
    const prompt = composeReviewPrompt({ ...BASE_OPTIONS, base: "origin/main" });
    expect(prompt).toContain("the changes on this branch against `origin/main`");
    expect(prompt).toContain("Change nothing");
  });

  it("points at the rules file whether or not it exists", () => {
    const prompt = composeReviewPrompt(BASE_OPTIONS);
    expect(prompt).toContain("/repo/.gavin-root/REVIEW.md");
    expect(prompt).toContain("do not create it");
  });

  it("asks for one card per finding, with the context folder to file into", () => {
    const prompt = composeReviewPrompt(BASE_OPTIONS);
    expect(prompt).toContain("gavin_create_plan");
    expect(prompt).toContain("`/repo`");
    expect(prompt).toContain("review-");
  });

  it("gives the hand-authored fallback when the gavin tools are unreachable", () => {
    const prompt = composeReviewPrompt(BASE_OPTIONS);
    expect(prompt).toContain("/repo/.gavin-root/plans");
  });

  it("lets a clean review file nothing", () => {
    expect(composeReviewPrompt(BASE_OPTIONS)).toContain("file none");
  });

  it("reviews a card's work and tells the agent to read the card", () => {
    const prompt = composeReviewPrompt({
      ...BASE_OPTIONS,
      card: { path: "/repo/.gavin-root/plans/x.md", fileName: "x.md", title: "Fix login", kind: "plan" },
    });
    expect(prompt).toContain('the work done for the card at /repo/.gavin-root/plans/x.md ("Fix login")');
    expect(prompt).toContain("what the work was FOR");
  });

  // Only a plan can be a parent, and a nested task has no status of its
  // own -- so the two instructions have to travel together.
  it("nests findings under a plan card", () => {
    const prompt = composeReviewPrompt({
      ...BASE_OPTIONS,
      card: { path: "/p/x.md", fileName: "x.md", title: "T", kind: "plan" },
    });
    expect(prompt).toContain("`parent`: `x.md`");
    expect(prompt).toContain("NO status");
    expect(prompt).not.toContain("gavin_get_board");
  });

  it("files a task card's findings free-standing, naming the card", () => {
    const prompt = composeReviewPrompt({
      ...BASE_OPTIONS,
      card: { path: "/p/x.md", fileName: "x.md", title: "T", kind: "task" },
    });
    expect(prompt).toContain("gavin_get_board");
    expect(prompt).toContain("name the card above in the body");
    expect(prompt).not.toContain("`parent`");
  });

  it("never leaves a blank line doubled up", () => {
    const prompt = composeReviewPrompt(BASE_OPTIONS);
    expect(prompt).not.toContain("\n\n\n");
  });
});

describe("reviewBlocker", () => {
  it("clears when there is a context and a prompt-taking agent", () => {
    expect(
      reviewBlocker({ promptArgs: "", agentLabel: "Claude Code", contextFolder: "/repo" })
    ).toBeNull();
  });

  it("refuses a workspace with nowhere to file findings", () => {
    expect(
      reviewBlocker({ promptArgs: "", agentLabel: "Claude Code", contextFolder: null })
    ).toContain("nowhere to file");
  });

  it("reuses the card runs' sentence for an agent that takes no prompt", () => {
    expect(
      reviewBlocker({ promptArgs: null, agentLabel: "Cursor", contextFolder: "/repo" })
    ).toContain("Cursor takes no prompt");
  });

  // Checked in this order: an agent that takes no prompt refuses every
  // review, but "no context" is the one the human can act on first.
  it("reports the missing context before the agent", () => {
    expect(
      reviewBlocker({ promptArgs: null, agentLabel: "Cursor", contextFolder: null })
    ).toContain("nowhere to file");
  });
});
