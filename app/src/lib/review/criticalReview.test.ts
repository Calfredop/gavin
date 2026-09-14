import { describe, it, expect } from "vitest";
import {
  reviewersError,
  criticalReviewPageName,
  criticalReviewDialogSeedKey,
  earliestStepBaseSha,
  seedCriticalReviewBase,
  reviewerPromptSuffix,
  composeCriticalReviewPrompt,
  cardSubjectLabel,
  railSubjectLabel,
  seedCandidates,
  parseReviewersParam,
  alsoBuildFindingsRailParam,
  critiqueSessionsComplete,
} from "$lib/review/criticalReview";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = {
  base: "main",
  rulesPath: "/repo/.gavin-root/REVIEW.md",
  contextFolder: "/repo",
  plansFolder: "/repo/.gavin-root/plans",
  reviewerLabel: "Claude Code · opus",
  reviewerTotal: 2,
};

describe("reviewersError", () => {
  it("refuses a single reviewer — that is Review with agent", () => {
    expect(reviewersError([{ profileId: "claude-code", model: "" }])).toMatch(
      /at least two reviewers/
    );
    expect(reviewersError([{ profileId: "claude-code", model: "" }])).toMatch(
      /Review with agent/
    );
  });

  it("refuses two identical profile+model rows", () => {
    expect(
      reviewersError([
        { profileId: "claude-code", model: "sonnet" },
        { profileId: "claude-code", model: "sonnet" },
      ])
    ).toMatch(/same agent and model/);
  });

  it("clears for two distinct reviewers", () => {
    expect(
      reviewersError([
        { profileId: "claude-code", model: "sonnet" },
        { profileId: "claude-code", model: "opus" },
      ])
    ).toBeNull();
  });
});

describe("seedCandidates", () => {
  // Re-exported from bestOfN — the dialog seeds the same way.
  it("is the Best-of-N seeder", () => {
    const pair = seedCandidates(
      [{ id: "claude-code", models: ["sonnet", "opus"], promptArgs: "" }],
      "claude-code",
      "sonnet"
    );
    expect(pair).toEqual([
      { profileId: "claude-code", model: "sonnet" },
      { profileId: "claude-code", model: "opus" },
    ]);
  });
});

describe("criticalReviewPageName", () => {
  it("names the page for the subject", () => {
    expect(criticalReviewPageName("Fix login")).toBe("Critical review: Fix login");
    expect(criticalReviewPageName("  auth   rail  ")).toBe("Critical review: auth rail");
  });

  it("falls back when the subject has no words", () => {
    expect(criticalReviewPageName("   ")).toBe("Critical review");
  });
});

describe("criticalReviewDialogSeedKey", () => {
  // The dialog is mounted for the app's life and re-seeds when a new
  // request lands. Gating on `request === seededFor` with `$state` loops
  // forever: Svelte 5 proxies every object it stores, so identity never
  // holds, the effect clears the reviewer rows on every tick, and a click
  // on "+ Add reviewer" lands on the backdrop and closes the modal.
  it("is null when nothing is pending", () => {
    expect(criticalReviewDialogSeedKey(null)).toBeNull();
  });

  it("is a stable string for the same subject, not the request object", () => {
    const a = {
      workspaceId: "ws-1",
      subjectKind: "card" as const,
      subject: "the work done for Fix login",
      railId: null,
    };
    const b = { ...a };
    expect(criticalReviewDialogSeedKey(a)).toBe(criticalReviewDialogSeedKey(b));
    expect(criticalReviewDialogSeedKey(a)).toContain("ws-1");
    expect(criticalReviewDialogSeedKey(a)).toContain("card");
  });

  it("differs when the subject changes", () => {
    const card = {
      workspaceId: "ws-1",
      subjectKind: "card" as const,
      subject: "card A",
      railId: null,
    };
    const rail = {
      workspaceId: "ws-1",
      subjectKind: "rail" as const,
      subject: "rail “auth”",
      railId: "r1",
    };
    expect(criticalReviewDialogSeedKey(card)).not.toBe(criticalReviewDialogSeedKey(rail));
  });

  it("the dialog seeds on that key, never on request-object identity", () => {
    const dialog = readFileSync(
      join(import.meta.dirname, "CriticalReviewDialog.svelte"),
      "utf8"
    );
    expect(dialog).toContain("criticalReviewDialogSeedKey");
    expect(dialog).not.toMatch(/request\s*===\s*seededFor/);
  });
});

describe("rail baseline seed", () => {
  it("prefers a worktree fork point", () => {
    expect(
      seedCriticalReviewBase({
        worktreeForkPoint: "abc1234",
        stepBaseShas: ["ddddddd", "eeeeeee"],
        defaultBase: "main",
      })
    ).toBe("abc1234");
  });

  it("falls back to the earliest step baseSha in order", () => {
    expect(earliestStepBaseSha([null, "", "  aaa  ", "bbb"])).toBe("aaa");
    expect(
      seedCriticalReviewBase({
        worktreeForkPoint: null,
        stepBaseShas: [null, "first", "second"],
        defaultBase: "main",
      })
    ).toBe("first");
  });

  it("falls back to the trunk default when nothing else is known", () => {
    expect(
      seedCriticalReviewBase({
        worktreeForkPoint: "  ",
        stepBaseShas: [null, ""],
        defaultBase: "origin/main",
      })
    ).toBe("origin/main");
  });
});

describe("composeCriticalReviewPrompt", () => {
  it("keeps the single-agent filing path", () => {
    const prompt = composeCriticalReviewPrompt(BASE);
    expect(prompt).toContain("gavin_create_plan");
    expect(prompt).toContain("review-");
    expect(prompt).toContain("/repo/.gavin-root/REVIEW.md");
  });

  it("frames the reviewer as one of N in a shared checkout", () => {
    const prompt = composeCriticalReviewPrompt(BASE);
    expect(prompt).toContain("one of 2 reviewers");
    expect(prompt).toContain("same checkout");
    expect(prompt).toContain("“Claude Code · opus”");
    expect(prompt).toContain("change no files");
  });

  it("asks the tab name to lead with the reviewer label", () => {
    expect(composeCriticalReviewPrompt(BASE)).toContain(
      "Begin your tab name with “Claude Code · opus ”"
    );
  });

  it("mentions the findings rail only when the toggle is on", () => {
    expect(composeCriticalReviewPrompt(BASE)).not.toContain("findings rail");
    expect(
      composeCriticalReviewPrompt({ ...BASE, alsoBuildFindingsRail: true })
    ).toContain("findings rail");
  });

  it("reviews a card subject through the shared composer", () => {
    const prompt = composeCriticalReviewPrompt({
      ...BASE,
      card: {
        path: "/repo/.gavin-root/plans/x.md",
        fileName: "x.md",
        title: "Fix login",
        kind: "plan",
      },
    });
    expect(prompt).toContain('the work done for the card at /repo/.gavin-root/plans/x.md');
    expect(prompt).toContain("`parent`: `x.md`");
  });
});

describe("reviewerPromptSuffix", () => {
  it("is blank-line safe when appended", () => {
    const suffix = reviewerPromptSuffix("Codex", 3);
    expect(suffix.startsWith("\n")).toBe(true);
    expect(suffix).not.toContain("\n\n\n");
  });
});

describe("subject labels", () => {
  it("matches the single-agent review's card wording", () => {
    expect(cardSubjectLabel("Fix login")).toBe('the work done for “Fix login”');
  });

  it("names a rail", () => {
    expect(railSubjectLabel("auth")).toBe("rail “auth”");
  });
});

describe("rail-step params", () => {
  it("parses profile and profile:model lines", () => {
    expect(parseReviewersParam("claude-code\ncodex:gpt-5\n\n")).toEqual([
      { profileId: "claude-code", model: "" },
      { profileId: "codex", model: "gpt-5" },
    ]);
    expect(parseReviewersParam("  ")).toEqual([]);
  });

  it("reads the auto-build toggle as off unless explicitly on", () => {
    expect(alsoBuildFindingsRailParam(undefined)).toBe(false);
    expect(alsoBuildFindingsRailParam("off")).toBe(false);
    expect(alsoBuildFindingsRailParam("on")).toBe(true);
    expect(alsoBuildFindingsRailParam("YES")).toBe(true);
  });

  it("completes when every reviewer is idle-after-working or gone", () => {
    expect(
      critiqueSessionsComplete({
        sessionIds: ["a", "b"],
        liveSessionIds: new Set(["a", "b"]),
        sessionStatuses: new Map([
          ["a", "idle"],
          ["b", "idle"],
        ]),
        sessionsSeenWorking: new Set(["a", "b"]),
      })
    ).toBe(true);
    expect(
      critiqueSessionsComplete({
        sessionIds: ["a", "b"],
        liveSessionIds: new Set(["a"]),
        sessionStatuses: new Map([["a", "idle"]]),
        sessionsSeenWorking: new Set(["a"]),
      })
    ).toBe(true);
    expect(
      critiqueSessionsComplete({
        sessionIds: ["a", "b"],
        liveSessionIds: new Set(["a", "b"]),
        sessionStatuses: new Map([
          ["a", "idle"],
          ["b", "working"],
        ]),
        sessionsSeenWorking: new Set(["a", "b"]),
      })
    ).toBe(false);
    expect(
      critiqueSessionsComplete({
        sessionIds: ["a"],
        liveSessionIds: new Set(["a"]),
        sessionStatuses: new Map([["a", "idle"]]),
        sessionsSeenWorking: new Set(),
      })
    ).toBe(false);
  });
});
