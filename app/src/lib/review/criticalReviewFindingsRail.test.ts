import { describe, it, expect } from "vitest";
import { emptyOrchestration } from "$lib/orchestration/orchestration";
import {
  NO_FINDINGS_ERROR,
  buildFindingsRail,
  collectFindingsForRun,
  cullFindings,
  findingsRailName,
  isReviewFindingFileName,
  type FindingCardRef,
} from "$lib/review/criticalReviewFindingsRail";

function finding(over: Partial<FindingCardRef> & Pick<FindingCardRef, "path" | "fileName">): FindingCardRef {
  return {
    title: over.title ?? over.fileName,
    modifiedAt: over.modifiedAt ?? null,
    parent: over.parent ?? null,
    order: over.order ?? null,
    ...over,
  };
}

describe("isReviewFindingFileName", () => {
  it("matches the filing prefix, with or without .md", () => {
    expect(isReviewFindingFileName("review-null-check.md")).toBe(true);
    expect(isReviewFindingFileName("review-null-check")).toBe(true);
    expect(isReviewFindingFileName("fix-login.md")).toBe(false);
    expect(isReviewFindingFileName("preview-thing.md")).toBe(false);
  });
});

describe("collectFindingsForRun", () => {
  const run = { startedAt: 1_700_000_000_000, cardPath: "/ws/plans/auth.md" };

  it("keeps nested review cards under the reviewed plan", () => {
    const cards = [
      finding({ path: "/a.md", fileName: "review-a.md", parent: "auth.md", title: "A" }),
      finding({ path: "/b.md", fileName: "other.md", parent: "auth.md", title: "B" }),
      finding({ path: "/c.md", fileName: "review-c.md", parent: "other.md", title: "C" }),
    ];
    expect(
      collectFindingsForRun(run, cards, { fileName: "auth.md", kind: "plan" }).map((f) => f.path)
    ).toEqual(["/a.md"]);
  });

  it("keeps free-standing review cards filed at or after the run started", () => {
    const cards = [
      finding({
        path: "/old.md",
        fileName: "review-old.md",
        modifiedAt: 1_699_000_000,
        title: "Old",
      }),
      finding({
        path: "/new.md",
        fileName: "review-new.md",
        modifiedAt: 1_700_000_001,
        title: "New",
      }),
    ];
    expect(collectFindingsForRun(run, cards, null).map((f) => f.path)).toEqual(["/new.md"]);
  });

  it("orders by order, then mtime, then title", () => {
    const cards = [
      finding({ path: "/c.md", fileName: "review-c.md", order: 2, title: "C", modifiedAt: 10 }),
      finding({ path: "/a.md", fileName: "review-a.md", order: 1, title: "A", modifiedAt: 20 }),
      finding({ path: "/b.md", fileName: "review-b.md", order: 1, title: "B", modifiedAt: 5 }),
    ];
    expect(
      collectFindingsForRun(
        { startedAt: 0, cardPath: null },
        cards,
        null
      ).map((f) => f.path)
    ).toEqual(["/b.md", "/a.md", "/c.md"]);
  });
});

describe("cullFindings", () => {
  it("preserves collect order while dropping unchecked paths", () => {
    const findings = [
      finding({ path: "/a.md", fileName: "review-a.md", title: "A" }),
      finding({ path: "/b.md", fileName: "review-b.md", title: "B" }),
      finding({ path: "/c.md", fileName: "review-c.md", title: "C" }),
    ];
    expect(cullFindings(findings, new Set(["/c.md", "/a.md"])).map((f) => f.path)).toEqual([
      "/a.md",
      "/c.md",
    ]);
  });
});

describe("findingsRailName", () => {
  it("names the rail for the subject", () => {
    expect(findingsRailName("Fix login")).toBe("Findings: Fix login");
    expect(findingsRailName("  auth   rail  ")).toBe("Findings: auth rail");
    expect(findingsRailName("   ")).toBe("Findings");
  });
});

describe("buildFindingsRail", () => {
  it("refuses an empty findings list", () => {
    expect(
      buildFindingsRail(emptyOrchestration(), {
        railId: "r1",
        name: "Findings: x",
        findings: [],
      })
    ).toEqual({ ok: false, error: NO_FINDINGS_ERROR });
  });

  it("creates one stage per finding in the given order", () => {
    const result = buildFindingsRail(emptyOrchestration(), {
      railId: "r-findings",
      name: "Findings: Fix login",
      findings: [
        { stepId: "s1", cardPath: "/ws/plans/review-a.md" },
        { stepId: "s2", cardPath: "/ws/plans/review-b.md" },
        { stepId: "s3", cardPath: "/ws/plans/review-c.md" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rail = result.orch.rails.find((r) => r.id === "r-findings");
    expect(rail?.name).toBe("Findings: Fix login");
    expect(rail?.stages.map((s) => s.steps.map((t) => t.cardPath))).toEqual([
      ["/ws/plans/review-a.md"],
      ["/ws/plans/review-b.md"],
      ["/ws/plans/review-c.md"],
    ]);
    expect(rail?.stages.map((s) => s.steps[0].id)).toEqual(["s1", "s2", "s3"]);
  });
});
