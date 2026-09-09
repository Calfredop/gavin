import { describe, it, expect } from "vitest";
import {
  DEFAULT_GIT_TRACKING,
  canToggleTracking,
  isGavinOwnPath,
  needsUntrackConfirm,
  normalizeGitTracking,
  resolveGitTracking,
  trackingSummary,
  untrackConfirm,
  type GavinTracking,
} from "$lib/gitTracking";

const status = (over: Partial<GavinTracking> = {}): GavinTracking => ({
  isRepo: true,
  tracked: true,
  ignoredBy: null,
  gavinManaged: false,
  indexed: 0,
  ...over,
});

describe("the app-wide default", () => {
  it("ships on -- the board is the project's plan", () => {
    expect(DEFAULT_GIT_TRACKING).toBe(true);
  });

  it("keeps 'chose off' apart from 'never chose'", () => {
    expect(normalizeGitTracking(false)).toBe(false);
    expect(normalizeGitTracking(null)).toBe(null);
    expect(normalizeGitTracking(undefined)).toBe(null);
    // config.json is a file a user can edit.
    expect(normalizeGitTracking("yes")).toBe(null);
    expect(normalizeGitTracking(1)).toBe(null);
  });

  it("falls through to gavin's default only when nobody chose", () => {
    expect(resolveGitTracking(false)).toBe(false);
    expect(resolveGitTracking(true)).toBe(true);
    expect(resolveGitTracking(null)).toBe(DEFAULT_GIT_TRACKING);
    expect(resolveGitTracking("nonsense")).toBe(DEFAULT_GIT_TRACKING);
  });
});

describe("whether the switch can act", () => {
  it("cannot outside a repo -- there is no ignore file worth writing", () => {
    expect(canToggleTracking(status({ isRepo: false }))).toBe(false);
  });

  it("cannot before the first read has landed", () => {
    expect(canToggleTracking(null)).toBe(false);
  });

  it("can while nothing ignores gavin, and while gavin's own block does", () => {
    expect(canToggleTracking(status())).toBe(true);
    expect(
      canToggleTracking(
        status({ tracked: false, gavinManaged: true, ignoredBy: ".gitignore:4:.gavin/" })
      )
    ).toBe(true);
  });

  it("cannot when somebody else's rule is what ignores gavin", () => {
    // Removing gavin's block (there is none) would leave that rule
    // standing and the switch would spring straight back.
    expect(
      canToggleTracking(
        status({ tracked: false, gavinManaged: false, ignoredBy: "../.gitignore:2:.gavin*" })
      )
    ).toBe(false);
  });
});

describe("the sentence under the switch", () => {
  it("says the reads are still out rather than answering early", () => {
    expect(trackingSummary(null)).toBe("Checking…");
  });

  it("names the missing repo rather than the setting", () => {
    expect(trackingSummary(status({ isRepo: false }))).toContain("not a git repository");
  });

  it("distinguishes tracked-and-committed from tracked-and-never-staged", () => {
    expect(trackingSummary(status({ indexed: 12 }))).toContain("12 files are in git");
    expect(trackingSummary(status())).toContain("Nothing is committed yet");
  });

  it("counts one file in the singular", () => {
    expect(trackingSummary(status({ indexed: 1 }))).toContain("1 file is in git");
  });

  it("names the foreign rule, since gavin cannot undo it", () => {
    const s = status({ tracked: false, ignoredBy: "/home/me/.config/git/ignore:9:.gavin*" });
    const line = trackingSummary(s);
    expect(line).toContain("/home/me/.config/git/ignore:9:.gavin*");
    expect(line).toContain("yourself");
  });

  it("says when an off left files behind in the index", () => {
    const s = status({ tracked: false, gavinManaged: true, indexed: 3 });
    expect(trackingSummary(s)).toContain("3 files are still in git");
  });

  it("says the files stay on disk once the index is clear", () => {
    const s = status({ tracked: false, gavinManaged: true, indexed: 0 });
    expect(trackingSummary(s)).toContain("stay on disk");
  });
});

describe("whether the index question is owed", () => {
  it("is never owed for an on -- turning tracking back on stages nothing", () => {
    expect(needsUntrackConfirm(status({ tracked: false, indexed: 9 }), true)).toBe(false);
  });

  it("is not owed for an off with none of gavin's files committed", () => {
    // The fresh-workspace case, and the common one: a prompt about zero
    // files is a prompt about nothing.
    expect(needsUntrackConfirm(status({ indexed: 0 }), false)).toBe(false);
  });

  it("is owed for an off in a repo that already committed them", () => {
    expect(needsUntrackConfirm(status({ indexed: 1 }), false)).toBe(true);
  });

  it("is not owed before the read lands", () => {
    expect(needsUntrackConfirm(null, false)).toBe(false);
  });
});

describe("the untrack confirm", () => {
  it("quotes the count and promises the files survive", () => {
    const copy = untrackConfirm(4);
    expect(copy.lines[0]).toContain("4 files");
    expect(copy.lines.join(" ")).toContain("stays on disk");
    // The action stages; it never commits. That is the sentence a human
    // mid-commit needs before they press it.
    expect(copy.lines.join(" ")).toContain("Nothing is committed");
    expect(copy.confirmLabel).not.toBe("OK");
  });

  it("counts one file in the singular", () => {
    expect(untrackConfirm(1).lines[0]).toContain("1 file ");
  });
});

describe("recognising gavin's own paths", () => {
  it("claims the two folders themselves", () => {
    expect(isGavinOwnPath(".gavin-root")).toBe(true);
    expect(isGavinOwnPath(".gavin")).toBe(true);
  });

  it("claims everything under them, at any depth", () => {
    expect(isGavinOwnPath(".gavin-root/PRD.md")).toBe(true);
    expect(isGavinOwnPath(".gavin-root/plans/done/a.md")).toBe(true);
    expect(isGavinOwnPath("apps/web/.gavin/plans/b.md")).toBe(true);
    expect(isGavinOwnPath("apps/web/.gavin")).toBe(true);
  });

  it("leaves a path that merely ENDS in one of the names alone", () => {
    // The Rust pathspecs use `:(glob)` for exactly this: `*` must not
    // cross a separator, so a folder called `my.gavin` is the human's.
    expect(isGavinOwnPath("my.gavin/notes.md")).toBe(false);
    expect(isGavinOwnPath("src/not.gavin-root/x.ts")).toBe(false);
    expect(isGavinOwnPath(".gavin-rootish/x.ts")).toBe(false);
  });

  it("leaves ordinary work alone", () => {
    expect(isGavinOwnPath("app/src/lib/git.ts")).toBe(false);
    expect(isGavinOwnPath("README.md")).toBe(false);
    expect(isGavinOwnPath("")).toBe(false);
  });
});
