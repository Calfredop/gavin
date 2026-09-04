import { describe, it, expect } from "vitest";
import {
  cardIsOutside,
  cardKey,
  decoyEditedSteps,
  mirrorCardPath,
  relativeTo,
} from "./worktreeCards";
import type { Rail } from "./orchestration";

const ROOT = "/ws";
const WT = "/wt/rail-a";
const A = "/ws/.gavin-root/plans/a.md";
const B = "/ws/.gavin-root/plans/b.md";

function rail(overrides: Partial<Rail> = {}): Rail {
  return {
    id: "r1",
    name: "r1",
    position: 0,
    worktreePath: WT,
    pageId: null,
    stages: [
      {
        id: "r1-s0",
        position: 0,
        steps: [
          { id: "t1", position: 0, cardPath: A },
          { id: "t2", position: 1, cardPath: B },
        ],
      },
    ],
    ...overrides,
  };
}

describe("relativeTo", () => {
  it("answers the part under the directory", () => {
    expect(relativeTo(A, ROOT)).toBe(".gavin-root/plans/a.md");
  });

  it("tolerates a trailing slash on the directory", () => {
    expect(relativeTo(A, "/ws/")).toBe(".gavin-root/plans/a.md");
  });

  // Fails closed: everything downstream treats null as "nothing to say",
  // and a sibling directory sharing a prefix must never read as inside.
  it("is null for a path outside, for the directory itself, and for a prefix twin", () => {
    expect(relativeTo("/elsewhere/a.md", ROOT)).toBeNull();
    expect(relativeTo("/ws", ROOT)).toBeNull();
    expect(relativeTo("/wsx/a.md", ROOT)).toBeNull();
  });
});

describe("mirrorCardPath", () => {
  it("is the card's path inside the rail's own checkout", () => {
    expect(mirrorCardPath(A, ROOT, WT)).toBe("/wt/rail-a/.gavin-root/plans/a.md");
  });

  it("is null with no worktree, no root, or a card filed outside the root", () => {
    expect(mirrorCardPath(A, ROOT, null)).toBeNull();
    expect(mirrorCardPath(A, null, WT)).toBeNull();
    expect(mirrorCardPath("/elsewhere/a.md", ROOT, WT)).toBeNull();
  });
});

describe("cardKey", () => {
  // The whole reason this exists: a "finished" decoy is usually MOVED,
  // and the three folders are one card's three homes.
  it("collapses plans/, plans/done/ and plans/archive/ to one identity", () => {
    const key = ".gavin-root/a.md";
    expect(cardKey(".gavin-root/plans/a.md")).toBe(key);
    expect(cardKey(".gavin-root/plans/done/a.md")).toBe(key);
    expect(cardKey(".gavin-root/plans/archive/a.md")).toBe(key);
  });

  it("keeps nested contexts apart", () => {
    expect(cardKey("app/.gavin/plans/a.md")).toBe("app/.gavin/a.md");
  });

  it("is null for a path that is not in a plans folder at all", () => {
    expect(cardKey("app/src/lib/a.md")).toBeNull();
  });
});

describe("decoyEditedSteps", () => {
  it("catches a step whose card was written inside the rail's checkout", () => {
    const found = decoyEditedSteps(rail(), ROOT, [{ path: ".gavin-root/plans/a.md" }]);
    expect([...found]).toEqual(["t1"]);
  });

  // The observed failure: the agent moved the copy into plans/done/.
  // Git reports that as a rename, or as a delete plus an untracked add,
  // and a literal path match would miss every spelling of it.
  it("catches the card after the agent moved it into plans/done/", () => {
    const renamed = decoyEditedSteps(rail(), ROOT, [
      { path: ".gavin-root/plans/done/a.md", oldPath: ".gavin-root/plans/a.md" },
    ]);
    expect([...renamed]).toEqual(["t1"]);
    const split = decoyEditedSteps(rail(), ROOT, [{ path: ".gavin-root/plans/done/a.md" }]);
    expect([...split]).toEqual(["t1"]);
  });

  it("says nothing about the ordinary code changes a run makes", () => {
    const found = decoyEditedSteps(rail(), ROOT, [
      { path: "app/src/lib/git.ts" },
      { path: "crates/daemon/src/lib.rs" },
    ]);
    expect(found.size).toBe(0);
  });

  // Every unknown is silence. A false "your agent edited the wrong file"
  // sends the human hunting for a write that never happened.
  it("says nothing without a worktree, without a root, or with nothing dirty", () => {
    expect(decoyEditedSteps(rail({ worktreePath: null }), ROOT, [{ path: ".gavin-root/plans/a.md" }]).size).toBe(0);
    expect(decoyEditedSteps(rail(), null, [{ path: ".gavin-root/plans/a.md" }]).size).toBe(0);
    expect(decoyEditedSteps(rail(), ROOT, []).size).toBe(0);
  });

  // A workspace root that is not the repository root makes every
  // relative path disagree; matching nothing is the safe direction.
  it("says nothing when the root does not contain the card", () => {
    expect(decoyEditedSteps(rail(), "/other", [{ path: ".gavin-root/plans/a.md" }]).size).toBe(0);
  });

  // `git worktree list` includes the MAIN working tree, so a rail can be
  // bound to it -- and there the card the agent edits IS the card.
  // Without this the one correct thing an agent can do to a card would
  // be reported as the mistake.
  it("says nothing for a rail bound to the main checkout", () => {
    const onMain = rail({ worktreePath: ROOT });
    expect(decoyEditedSteps(onMain, ROOT, [{ path: ".gavin-root/plans/a.md" }]).size).toBe(0);
    expect(decoyEditedSteps(rail({ worktreePath: "/ws/" }), ROOT, [
      { path: ".gavin-root/plans/a.md" },
    ]).size).toBe(0);
  });

  it("never attributes a decoy to a tool step", () => {
    const toolRail = rail({
      stages: [
        {
          id: "r1-s0",
          position: 0,
          steps: [{ id: "t9", position: 0, cardPath: "", toolId: "builtin:push", toolParams: {} }],
        },
      ],
    });
    expect(decoyEditedSteps(toolRail, ROOT, [{ path: ".gavin-root/plans/a.md" }]).size).toBe(0);
  });
});

describe("cardIsOutside", () => {
  // The board Run case: the card is in the folder the agent starts in,
  // so there is no second copy and nothing to warn about.
  it("is false for a card the launch directory contains, and for no cwd at all", () => {
    expect(cardIsOutside(A, "/ws")).toBe(false);
    expect(cardIsOutside(A, "/ws/.gavin-root")).toBe(false);
    expect(cardIsOutside(A, null)).toBe(false);
  });

  it("is true for a launch in a checkout of its own", () => {
    expect(cardIsOutside(A, WT)).toBe(true);
  });
});
