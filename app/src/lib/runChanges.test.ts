import { describe, it, expect } from "vitest";
import {
  changesProblem,
  changesSummary,
  chipTooltip,
  discardBlockedReason,
  discardOutcome,
  discardPrompt,
  runBaseline,
  trackedFiles,
  untrackedPaths,
} from "./runChanges";
import { shortSha, type RunChanges } from "./git";
import type { CardSession } from "./kanban";

const BASE = "4a3a53b1111111111111111111111111111111ff";

function changes(over: Partial<RunChanges> = {}): RunChanges {
  return {
    baseSha: BASE,
    notARepo: false,
    baseMissing: false,
    root: "/repo",
    baseSubject: "the commit it started on",
    files: [],
    added: 0,
    removed: 0,
    commits: 0,
    ...over,
  };
}

function binding(over: Partial<CardSession> = {}): CardSession {
  return { path: "/p/t.md", sessionId: "s-1", cwd: "/p", command: null, ...over };
}

describe("runBaseline", () => {
  it("uses the LAUNCH directory, not the session's drifting cwd", () => {
    const state = runBaseline(binding({ cwd: "/p/somewhere/else", launchCwd: "/p/wt", baseSha: BASE }), null);
    expect(state).toEqual({ kind: "ready", cwd: "/p/wt", baseSha: BASE });
  });

  it("falls back to cwd when the binding predates launchCwd", () => {
    expect(runBaseline(binding({ baseSha: BASE }), null)).toEqual({
      kind: "ready",
      cwd: "/p",
      baseSha: BASE,
    });
  });

  it("names the daemon when the daemon is why there is no baseline", () => {
    const state = runBaseline(binding(), { daemonVersion: 25, appVersion: 26, degraded: true });
    expect(state.kind).toBe("none");
    // Both halves: what is missing, and the fact it is fixable by
    // restarting the daemon rather than by re-running the card.
    expect(state.kind === "none" && state.reason).toContain("couldn't record where this run started");
    expect(state.kind === "none" && state.reason).toContain("v26");
  });

  it("explains an old or non-repo run without blaming the daemon", () => {
    const state = runBaseline(binding(), { daemonVersion: 26, appVersion: 26, degraded: false });
    expect(state.kind === "none" && state.reason).toContain("not a git repository");
    expect(state.kind === "none" && state.reason).not.toContain("Restart the daemon");
  });

  it("an unbound card has nothing to compare", () => {
    expect(runBaseline(null, null).kind).toBe("none");
  });
});

describe("changesSummary", () => {
  it("counts files, lines and commits in one line", () => {
    const line = changesSummary(
      changes({
        files: [
          { path: "a.ts", status: "M" },
          { path: "b.ts", status: "?" },
        ],
        added: 240,
        removed: 18,
        commits: 2,
      })
    );
    expect(line).toBe("2 files · +240 −18 · 2 commits");
  });

  it("says so when the run has changed nothing yet", () => {
    expect(changesSummary(changes())).toBe("No changes yet");
  });

  it("drops the line counts when a change has none (a pure rename)", () => {
    expect(changesSummary(changes({ files: [{ path: "b.ts", oldPath: "a.ts", status: "R" }] }))).toBe("1 file");
  });

  it("has nothing to summarise while a state has an explanation instead", () => {
    expect(changesSummary(changes({ baseMissing: true }))).toBeNull();
    expect(changesSummary(changes({ notARepo: true }))).toBeNull();
    expect(changesSummary(null)).toBeNull();
  });
});

describe("changesProblem", () => {
  it("names the missing baseline by its short sha", () => {
    expect(changesProblem(changes({ baseMissing: true }))).toContain(shortSha(BASE));
  });

  it("says a non-repo folder plainly", () => {
    expect(changesProblem(changes({ notARepo: true }))).toContain("not inside a git repository");
  });

  it("is null for an ordinary answer", () => {
    expect(changesProblem(changes({ files: [{ path: "a.ts", status: "M" }] }))).toBeNull();
  });
});

describe("discardBlockedReason", () => {
  const dirty = changes({ files: [{ path: "a.ts", status: "M" }], added: 1, removed: 1 });

  it("refuses under a live agent, ahead of everything else", () => {
    // Even with nothing to discard: the sentence has to be about the
    // agent, because that is the thing the human must deal with.
    expect(discardBlockedReason(changes(), true)).toContain("still running");
  });

  it("refuses when the baseline is gone", () => {
    expect(discardBlockedReason(changes({ baseMissing: true }), false)).toContain("not in this checkout");
  });

  it("refuses a run that changed nothing", () => {
    expect(discardBlockedReason(changes(), false)).toContain("nothing to discard");
  });

  it("allows a discard when there is something to discard and nobody is working", () => {
    expect(discardBlockedReason(dirty, false)).toBeNull();
  });

  it("allows one for commits alone, with a clean tree", () => {
    expect(discardBlockedReason(changes({ commits: 1 }), false)).toBeNull();
  });
});

describe("discardPrompt", () => {
  const full = changes({
    files: [
      { path: "src/a.ts", status: "M" },
      { path: "src/new.ts", status: "?" },
    ],
    added: 12,
    removed: 3,
    commits: 2,
  });

  it("names every destructive consequence separately", () => {
    const prompt = discardPrompt(full, "Per-run Changes view");
    expect(prompt.title).toContain("Per-run Changes view");
    const text = prompt.lines.join("\n");
    expect(text).toContain(shortSha(BASE));
    expect(text).toContain("the commit it started on");
    expect(text).toContain("Edits to 1 file are reverted");
    expect(text).toContain("2 commits");
    expect(text).toContain("git reflog");
    expect(text).toContain("src/new.ts");
    expect(text).toContain("Trash");
    // The reset is the whole worktree, and a rail's checkout may hold a
    // second run's work: saying so is the difference between an informed
    // press and a surprise.
    expect(text).toContain("not this card's files");
  });

  it("hands back exactly the untracked paths it listed", () => {
    expect(discardPrompt(full, "x").untracked).toEqual(["src/new.ts"]);
  });

  it("leaves out the clauses that do not apply", () => {
    const text = discardPrompt(changes({ commits: 1 }), "x").lines.join("\n");
    expect(text).not.toContain("Trash");
    expect(text).not.toContain("reverted");
    expect(text).toContain("1 commit");
  });
});

describe("discardOutcome", () => {
  it("is silent when everything went as described", () => {
    expect(discardOutcome({ trashed: ["a.ts"], failed: [] })).toBeNull();
  });

  it("says the reset happened and names what stayed behind", () => {
    const message = discardOutcome({ trashed: [], failed: [["a.ts", "permission denied"]] });
    expect(message).toContain("was reset");
    expect(message).toContain("a.ts (permission denied)");
  });
});

describe("helpers", () => {
  it("splits tracked from untracked", () => {
    const c = changes({
      files: [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "?" },
        { path: "c.ts", status: "D" },
      ],
    });
    expect(untrackedPaths(c)).toEqual(["b.ts"]);
    expect(trackedFiles(c).map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("the chip names the baseline rather than a count it never fetched", () => {
    expect(chipTooltip(BASE)).toBe(`See what this run changed since ${shortSha(BASE)}`);
  });
});
