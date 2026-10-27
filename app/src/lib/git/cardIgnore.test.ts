import { describe, expect, it } from "vitest";
import {
  cardGitChoice,
  cardGitLocked,
  cardGitSummary,
  cardUntrackConfirm,
  needsCardUntrackConfirm,
  type CardIgnore,
} from "./cardIgnore";

function status(over: Partial<CardIgnore> = {}): CardIgnore {
  return {
    isRepo: true,
    pattern: "/.gavin-root/plans/**/a.md",
    ruleIn: null,
    ignored: false,
    decidedBy: null,
    decidedByGavin: false,
    indexed: false,
    ...over,
  };
}

const GAVIN_EXCLUDED = status({
  ruleIn: "exclude",
  ignored: true,
  decidedBy: ".git/info/exclude:7:/.gavin-root/plans/**/a.md",
  decidedByGavin: true,
});

describe("cardGitChoice", () => {
  it("is the file holding gavin's rule, else tracked", () => {
    expect(cardGitChoice(null)).toBe("tracked");
    expect(cardGitChoice(status())).toBe("tracked");
    expect(cardGitChoice(GAVIN_EXCLUDED)).toBe("exclude");
  });

  it("reads tracked for a card some other rule ignores", () => {
    expect(cardGitChoice(status({ ignored: true, decidedBy: ".gitignore:1:.gavin-root/" }))).toBe("tracked");
  });
});

describe("cardGitLocked", () => {
  it("locks while unknown and outside a repo", () => {
    expect(cardGitLocked(null)).toBe(true);
    expect(cardGitLocked(status({ isRepo: false }))).toBe(true);
  });

  it("locks when only a rule gavin did not write ignores the card", () => {
    expect(cardGitLocked(status({ ignored: true, decidedBy: ".gitignore:1:.gavin-root/" }))).toBe(true);
  });

  it("stays open while gavin's own line is there, even beside another rule", () => {
    expect(cardGitLocked(GAVIN_EXCLUDED)).toBe(false);
    expect(
      cardGitLocked(status({ ruleIn: "exclude", ignored: true, decidedBy: ".gitignore:1:.gavin-root/" }))
    ).toBe(false);
    expect(cardGitLocked(status())).toBe(false);
  });
});

describe("cardGitSummary", () => {
  it("names the file that keeps the card out", () => {
    expect(cardGitSummary(GAVIN_EXCLUDED)).toContain("this machine only");
    expect(
      cardGitSummary(status({ ruleIn: "gitignore", ignored: true, decidedByGavin: true, decidedBy: "x" }))
    ).toContain("everyone who clones");
  });

  it("names a rule gavin did not write", () => {
    expect(cardGitSummary(status({ ignored: true, decidedBy: ".gitignore:1:.gavin-root/" }))).toContain(
      ".gitignore:1:.gavin-root/"
    );
  });

  it("says a committed card is still in git after an ignore", () => {
    expect(cardGitSummary({ ...GAVIN_EXCLUDED, indexed: true })).toContain("still in git");
  });

  it("says when a negation overrides gavin's rule", () => {
    const s = status({ ruleIn: "exclude", decidedBy: ".gitignore:2:!/.gavin-root/plans/a.md" });
    expect(cardGitSummary(s)).toContain("un-ignores");
  });
});

describe("needsCardUntrackConfirm", () => {
  it("asks only before an ignore of an indexed card", () => {
    expect(needsCardUntrackConfirm(status({ indexed: true }), "exclude")).toBe(true);
    expect(needsCardUntrackConfirm(status({ indexed: true }), "gitignore")).toBe(true);
    expect(needsCardUntrackConfirm(status({ indexed: true }), "tracked")).toBe(false);
    expect(needsCardUntrackConfirm(status(), "exclude")).toBe(false);
    expect(needsCardUntrackConfirm(null, "exclude")).toBe(false);
  });
});

describe("cardUntrackConfirm", () => {
  it("names the action, never OK, and offers the untrack as a tick-box", () => {
    const c = cardUntrackConfirm("exclude");
    expect(c.confirmLabel).toBe("Exclude");
    expect(c.check.label).toMatch(/untrack/i);
    expect(c.lines.join(" ")).toContain("stays on disk");
  });
});
