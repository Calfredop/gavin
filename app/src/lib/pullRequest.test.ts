import { describe, it, expect } from "vitest";
import {
  EMPTY_ROLLUP_GRACE_SECS,
  checkRollup,
  failingChecksNote,
  observedTip,
  prChips,
  prExhaustedReason,
  prRequirement,
  prWaitVerdict,
} from "./pullRequest";
import type { PrCheck, PrReport } from "./pullRequest";

const NOW = 1_000_000;

function check(name: string, state: PrCheck["state"], url = ""): PrCheck {
  return { name, state, url };
}

function ready(over: Partial<Extract<PrReport, { state: "ready" }>> = {}): PrReport {
  return {
    state: "ready",
    number: 42,
    url: "https://example.test/pr/42",
    title: "Add a thing",
    prState: "OPEN",
    isDraft: false,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    // Old enough that the empty-rollup grace has expired, so a test that
    // is not about the grace never trips over it.
    createdAt: NOW - 3600,
    checks: [],
    observedAt: NOW,
    cached: false,
    ...over,
  };
}

function verdict(report: PrReport | undefined, over: Record<string, unknown> = {}) {
  return prWaitVerdict({
    report,
    requirement: "checks",
    attempts: 0,
    max: 3,
    previousStepId: "s1",
    now: NOW,
    ...over,
  });
}

describe("checkRollup", () => {
  it("counts each verdict once", () => {
    const rollup = checkRollup([
      check("a", "success"),
      check("b", "failure"),
      check("c", "pending"),
      check("d", "skipped"),
      check("e", "cancelled"),
    ]);
    expect(rollup).toMatchObject({ total: 5, passed: 1, failed: 1, pending: 1, ignored: 2 });
    expect(rollup.failing.map((c) => c.name)).toEqual(["b"]);
  });

  /// A conclusion this build does not recognise must never read as a
  /// pass -- the same posture an unwitnessed exit code gets.
  it("treats an unknown state as still running, not as passed", () => {
    expect(checkRollup([check("a", "unknown")])).toMatchObject({ passed: 0, pending: 1, failed: 0 });
  });
});

describe("prRequirement", () => {
  it("reads any wording that mentions review or approval as approval", () => {
    for (const said of ["approval", "Checks and approval", "review", "APPROVED", " approved "]) {
      expect(prRequirement(said)).toBe("approval");
    }
  });

  /// The narrower wait is the fallback, so a typo delays nobody.
  it("falls back to checks", () => {
    for (const said of ["checks", "", "ci", "nonsense"]) {
      expect(prRequirement(said)).toBe("checks");
    }
  });
});

describe("prWaitVerdict", () => {
  it("waits while the poll has not answered yet", () => {
    expect(verdict(undefined).kind).toBe("waiting");
  });

  it("waits through a branch with no pull request", () => {
    // The state every branch is in before builtin:open-pr runs. Passing
    // here would advance the rail past a PR that was never opened.
    expect(verdict({ state: "none" }).kind).toBe("waiting");
  });

  /// A transient gh failure keeps waiting and SAYS so; only a missing gh
  /// stalls, because that one never fixes itself.
  it("keeps waiting when gh could not answer, and stalls when there is no gh", () => {
    const unavailable = verdict({ state: "unavailable", reason: "gh auth expired" });
    expect(unavailable).toEqual({ kind: "waiting", note: "gh auth expired" });
    expect(verdict({ state: "missing", reason: "gh was not found on PATH" })).toEqual({
      kind: "stuck",
      reason: "gh was not found on PATH",
    });
  });

  it("passes when every check passed", () => {
    expect(verdict(ready({ checks: [check("build", "success")] })).kind).toBe("pass");
  });

  it("waits while any check is still running", () => {
    const v = verdict(ready({ checks: [check("a", "success"), check("b", "pending")] }));
    expect(v.kind).toBe("waiting");
    expect(v.kind === "waiting" && v.note).toContain("1 of 2 checks still running");
  });

  /// A failure outranks anything still pending: the build has already
  /// broken, and the other nine finishing will not change that.
  it("loops back on a failing check even while others run", () => {
    const v = verdict(ready({ checks: [check("a", "failure"), check("b", "pending")] }));
    expect(v).toMatchObject({ kind: "retry", previousStepId: "s1", attempt: 1, max: 3 });
    expect(v.kind === "retry" && v.note).toContain("#42");
  });

  it("gives up once the budget is spent", () => {
    const v = verdict(ready({ checks: [check("a", "failure")] }), { attempts: 3 });
    expect(v).toMatchObject({ kind: "exhausted", max: 3 });
  });

  /// Nothing runs before this step, so a failure has nowhere to send the
  /// rail. Saying so beats looping over itself.
  it("is stuck when a failure has nothing to go back to", () => {
    const v = verdict(ready({ checks: [check("a", "failure")] }), { previousStepId: null });
    expect(v.kind).toBe("stuck");
  });

  describe("an empty check rollup", () => {
    /// The dangerous shape: `gh pr create` returns before GitHub has
    /// registered the workflow runs, so a brand-new PR looks exactly like
    /// a repo with no CI.
    it("waits while the pull request is still new", () => {
      const v = verdict(ready({ checks: [], createdAt: NOW - 5 }));
      expect(v.kind).toBe("waiting");
    });

    it("passes once the grace period is over", () => {
      const v = verdict(ready({ checks: [], createdAt: NOW - EMPTY_ROLLUP_GRACE_SECS - 1 }));
      expect(v.kind).toBe("pass");
    });

    /// GitHub not saying when the PR was opened must not hold the rail
    /// forever; 0 means "did not say", and the grace cannot be measured.
    it("passes when GitHub gave no creation time", () => {
      expect(verdict(ready({ checks: [], createdAt: 0 })).kind).toBe("pass");
    });
  });

  describe("the review requirement", () => {
    const approval = { requirement: "approval" as const };

    it("waits for an approval that has not arrived", () => {
      const v = verdict(ready({ reviewDecision: "REVIEW_REQUIRED" }), approval);
      expect(v.kind).toBe("waiting");
      expect(v.kind === "waiting" && v.note).toContain("approval");
    });

    it("says a draft is a draft rather than blaming the reviewer", () => {
      const v = verdict(ready({ isDraft: true, reviewDecision: "" }), approval);
      expect(v.kind === "waiting" && v.note).toContain("draft");
    });

    /// Changes requested is a failing check by another name, and the one
    /// a re-run has the best chance with.
    it("loops back when a reviewer requested changes", () => {
      const v = verdict(ready({ reviewDecision: "CHANGES_REQUESTED" }), approval);
      expect(v).toMatchObject({ kind: "retry", attempt: 1 });
    });

    it("passes on an approval", () => {
      expect(verdict(ready({ reviewDecision: "APPROVED" }), approval).kind).toBe("pass");
    });

    /// The same PR passes at once when the step only asked for checks.
    it("ignores review entirely when only checks were asked for", () => {
      expect(verdict(ready({ reviewDecision: "REVIEW_REQUIRED" })).kind).toBe("pass");
    });
  });

  describe("a pull request that ended", () => {
    it("passes on a merged one whatever its checks say", () => {
      const v = verdict(ready({ prState: "MERGED", checks: [check("a", "failure")] }));
      expect(v.kind).toBe("pass");
    });

    it("is stuck on a closed one", () => {
      const v = verdict(ready({ prState: "CLOSED" }));
      expect(v.kind).toBe("stuck");
      expect(v.kind === "stuck" && v.reason).toContain("#42");
    });
  });
});

describe("failingChecksNote", () => {
  it("names every failing check and links it", () => {
    const note = failingChecksNote(
      ready({ checks: [check("build", "failure", "https://example.test/b"), check("ok", "success")] })
    );
    expect(note).toContain("1 check is failing");
    expect(note).toContain("- build — https://example.test/b");
    expect(note).not.toContain("ok");
  });

  /// A monorepo can fail forty checks at once, and a prompt that opens
  /// with forty URLs buries the instruction after it.
  it("caps the list and says how many were left out", () => {
    const checks = Array.from({ length: 15 }, (_, i) => check(`c${i}`, "failure"));
    const note = failingChecksNote(ready({ checks }), 10);
    expect(note).toContain("…and 5 more");
    expect(note.split("\n").length).toBe(12);
  });

  it("is empty when nothing failed, so nothing quotes an empty block", () => {
    expect(failingChecksNote(ready({ checks: [check("a", "success")] }))).toBe("");
    expect(failingChecksNote({ state: "none" })).toBe("");
  });
});

describe("prExhaustedReason", () => {
  it("counts the retries and quotes only the note's first line", () => {
    expect(prExhaustedReason(1, "two are failing\n- a\n- b")).toBe(
      "the pull request still was not ready after 1 retry — two are failing"
    );
    expect(prExhaustedReason(3, "")).toBe("the pull request still was not ready after 3 retries");
  });
});

describe("prChips", () => {
  it("says nothing at all when there is no pull request", () => {
    expect(prChips(undefined, NOW)).toEqual([]);
    expect(prChips({ state: "none" }, NOW)).toEqual([]);
  });

  it("leads with the number and links it", () => {
    const chips = prChips(ready(), NOW);
    expect(chips[0]).toMatchObject({ key: "pr", label: "#42", href: "https://example.test/pr/42" });
  });

  it("leads the check chip with the failures", () => {
    const chips = prChips(ready({ checks: [check("a", "failure"), check("b", "success")] }), NOW);
    const checksChip = chips.find((c) => c.key === "checks");
    expect(checksChip).toMatchObject({ label: "1 failing", tone: "danger" });
  });

  it("shows progress while checks run and a total once they are in", () => {
    const running = prChips(ready({ checks: [check("a", "success"), check("b", "pending")] }), NOW);
    expect(running.find((c) => c.key === "checks")).toMatchObject({ label: "1/2 checks", tone: "accent" });
    const done = prChips(ready({ checks: [check("a", "success")] }), NOW);
    expect(done.find((c) => c.key === "checks")).toMatchObject({ label: "1 checks passed", tone: "success" });
  });

  /// A repo that asks for no review has nothing to say about review, and
  /// a permanent grey chip saying so is noise on every rail.
  it("draws a review chip only when there is a decision", () => {
    expect(prChips(ready({ reviewDecision: "" }), NOW).some((c) => c.key === "review")).toBe(false);
    expect(prChips(ready({ reviewDecision: "APPROVED" }), NOW).some((c) => c.key === "review")).toBe(true);
  });

  /// UNKNOWN is GitHub's ordinary answer while it recomputes mergeability;
  /// a chip for it would cry wolf on every freshly pushed branch.
  it("flags conflicts and stays quiet about UNKNOWN", () => {
    expect(prChips(ready({ mergeable: "CONFLICTING" }), NOW).some((c) => c.key === "conflict")).toBe(true);
    expect(prChips(ready({ mergeable: "UNKNOWN" }), NOW).some((c) => c.key === "conflict")).toBe(false);
  });

  it("says why there is nothing to show when gh could not answer", () => {
    expect(prChips({ state: "unavailable", reason: "offline" }, NOW)).toEqual([
      { key: "gh", label: "PR unknown", tone: "warning", tip: "offline", href: null },
    ]);
    expect(prChips({ state: "missing", reason: "no gh" }, NOW)[0]).toMatchObject({ tone: "neutral" });
  });
});

describe("observedTip", () => {
  it("names the age past the first minute", () => {
    expect(observedTip(NOW, NOW)).toBe("checked just now");
    expect(observedTip(NOW - 600, NOW)).toBe("checked 10m ago");
    expect(observedTip(NOW - 7200, NOW)).toBe("checked 2h ago");
  });
});
