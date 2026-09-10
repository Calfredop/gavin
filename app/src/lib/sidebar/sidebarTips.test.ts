import { describe, it, expect } from "vitest";
import {
  cardRecapTip,
  formatAheadBehind,
  gitRecapTip,
  plural,
  railRecapTip,
  tabRowKindWord,
  tabRowTip,
  tabsRecapTip,
} from "$lib/sidebar/sidebarTips";
import type { GitStatus } from "$lib/core/workspace";

function git(over: Partial<GitStatus> = {}): GitStatus {
  return {
    repoRoot: "/ws",
    branch: "main",
    dirty: false,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    ...over,
  } as GitStatus;
}

describe("plural", () => {
  it("takes both forms, because not every noun pluralizes by suffix", () => {
    expect(plural(1, "repo", "repos")).toBe("1 repo");
    expect(plural(2, "repo", "repos")).toBe("2 repos");
    expect(plural(0, "file or board tab", "file or board tabs")).toBe("0 file or board tabs");
  });
});

describe("formatAheadBehind", () => {
  it("shows only the non-zero sides", () => {
    expect(formatAheadBehind(git({ ahead: 2 }))).toBe("↑2");
    expect(formatAheadBehind(git({ behind: 1 }))).toBe("↓1");
    expect(formatAheadBehind(git({ ahead: 2, behind: 1 }))).toBe("↑2 ↓1");
    expect(formatAheadBehind(git())).toBe("");
  });

  // Not merely zero: without an upstream there is nothing to compare
  // against, and `↑0 ↓0` would claim a comparison that never happened.
  it("is empty for a branch with no upstream, whatever the counts say", () => {
    expect(formatAheadBehind(git({ hasUpstream: false, ahead: 3, behind: 4 }))).toBe("");
  });
});

describe("gitRecapTip", () => {
  const base = { repoCount: 0, dirtyCount: 0, ahead: 0, behind: 0, committing: false };

  // The only part of the chip that is happening right now rather than
  // merely true.
  it("leads with a commit run in flight", () => {
    expect(gitRecapTip({ ...base, repoCount: 2, committing: true })).toBe(
      "an agent is committing, 2 repos -- open Git"
    );
  });

  // A run can be the chip's whole reason for existing, and "0 repos"
  // would be the loudest thing on it.
  it("drops the repo tally entirely at zero", () => {
    expect(gitRecapTip({ ...base, committing: true })).toBe("an agent is committing -- open Git");
  });

  it("names each non-zero part in order", () => {
    expect(gitRecapTip({ repoCount: 3, dirtyCount: 1, ahead: 2, behind: 4, committing: false })).toBe(
      "3 repos, 1 with uncommitted changes, 2 ahead, 4 behind -- open Git"
    );
  });
});

describe("cardRecapTip", () => {
  // The three-slot tally on the row folds custom columns together; this
  // is where that detail survives.
  it("names every column that holds a card", () => {
    expect(
      cardRecapTip({
        todo: 2,
        inProgress: 0,
        done: 1,
        total: 3,
        columns: [
          { name: "To Do", count: 2 },
          { name: "Blocked", count: 0 },
          { name: "Done", count: 1 },
        ],
      })
    ).toBe("3 cards: To Do 2, Done 1 -- open Kanban");
  });
});

describe("tabsRecapTip", () => {
  const base = { tabs: 0, agents: 0, running: 0, waiting: 0, failed: 0, idle: 0 };

  it("names the buckets the row draws as bare numbers", () => {
    expect(tabsRecapTip({ tabs: 3, agents: 3, running: 1, waiting: 1, failed: 1, idle: 0 })).toBe(
      "3 tabs -- 3 agents: 1 running, 1 waiting for input, 1 stopped because something broke"
    );
  });

  // The gap between the tab count and the agent count, which nothing
  // else on the row accounts for.
  it("accounts for the file and board tabs behind the difference", () => {
    expect(tabsRecapTip({ ...base, tabs: 3, agents: 1, idle: 1 })).toBe(
      "3 tabs -- 1 agent: 1 idle, 2 file or board tabs"
    );
  });

  it("says so plainly for a page of no agents at all", () => {
    expect(tabsRecapTip({ ...base, tabs: 2 })).toBe("2 tabs -- no agents, 2 file or board tabs");
  });
});

describe("railRecapTip", () => {
  it("names each non-zero phase", () => {
    expect(railRecapTip({ running: 1, attention: 2, done: 0, idle: 3, total: 6 })).toBe(
      "6 rails: 1 running, 2 needing you, 3 idle -- open Orchestration"
    );
  });
});

describe("tabRowKindWord", () => {
  it("names each non-agent kind", () => {
    expect(tabRowKindWord("file", false)).toBe("File");
    expect(tabRowKindWord("board", false)).toBe("Board");
    expect(tabRowKindWord("card", false)).toBe("Card");
  });

  // The one card row with no card: its subject is a session.
  it("calls a follow-up queue what it is", () => {
    expect(tabRowKindWord("card", true)).toBe("Follow-ups");
  });
});

describe("tabRowTip", () => {
  it("is one line for a row that points nowhere and holds no repo", () => {
    expect(tabRowTip({ lead: "Board", where: "", git: null })).toBe("Board");
  });

  // An empty `where` draws no line rather than a blank one.
  it("adds where it points, when it points anywhere", () => {
    expect(tabRowTip({ lead: "File", where: "/ws/a.txt", git: null })).toBe("File\n/ws/a.txt");
  });

  // Spelled out where the row can only afford glyphs -- including the
  // arrows, which the row already draws and a tooltip repeating would
  // explain nothing.
  it("spells the checkout out in full, arrows in words", () => {
    expect(
      tabRowTip({
        lead: "Agent · working",
        where: "/ws/project",
        git: git({ repoRoot: "/ws/project", branch: "feat/x", dirty: true, ahead: 2, behind: 1 }),
      })
    ).toBe("Agent · working\n/ws/project\n/ws/project -- on feat/x -- uncommitted changes -- ahead 2 behind 1");
  });

  it("says clean, and drops the sync clause with nothing to sync", () => {
    expect(tabRowTip({ lead: "Agent · idle", where: "", git: git() })).toBe(
      "Agent · idle\n/ws -- on main -- clean"
    );
  });
});
