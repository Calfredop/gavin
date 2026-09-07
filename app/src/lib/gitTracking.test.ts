import { describe, it, expect } from "vitest";
import {
  DEFAULT_GIT_TRACKING,
  canToggleTracking,
  normalizeGitTracking,
  resolveGitTracking,
  trackingSummary,
  untrackConfirm,
  type GavinTracking,
} from "./gitTracking";

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
