import { describe, it, expect } from "vitest";
import {
  recentWorkspaces,
  relativeTime,
  appLinks,
  workspaceRecapLine,
  APP_LINKS,
  APP_VERSION,
  type AppLink,
} from "./appHub";
import type { WorkspaceAgentsSummary } from "./sidebarSummary";
import { UNFILED_WORKSPACE_ID, type Workspace } from "./workspace";

function ws(id: string, lastActiveAt?: number): Workspace {
  return { id, name: id.toUpperCase(), pages: [], activePageId: null, lastActiveAt };
}

describe("recentWorkspaces", () => {
  it("orders stamped workspaces newest first", () => {
    const list = [ws("a", 100), ws("b", 300), ws("c", 200)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual(["b", "c", "a"]);
  });

  it("puts never-switched workspaces after every stamped one", () => {
    const list = [ws("never1"), ws("a", 100), ws("never2"), ws("b", 300)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual(["b", "a", "never1", "never2"]);
  });

  it("keeps never-switched workspaces in sidebar order, Scratchpad pinned first", () => {
    const list = [ws("a"), ws(UNFILED_WORKSPACE_ID), ws("b")];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual([UNFILED_WORKSPACE_ID, "a", "b"]);
  });

  it("breaks a tie on sidebar order rather than on array order", () => {
    // Both stamped at 100; sidebarWorkspaceOrder pins the Scratchpad
    // ahead of "a" even though it comes second in the input.
    const list = [ws("a", 100), ws(UNFILED_WORKSPACE_ID, 100)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual([UNFILED_WORKSPACE_ID, "a"]);
  });

  it("treats the Scratchpad as an ordinary recent once it has been used", () => {
    const list = [ws(UNFILED_WORKSPACE_ID, 100), ws("a", 300)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual(["a", UNFILED_WORKSPACE_ID]);
  });

  it("does not mutate the array it was given", () => {
    const list = [ws("a", 100), ws("b", 300)];
    recentWorkspaces(list);
    expect(list.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("is empty for an empty list", () => {
    expect(recentWorkspaces([])).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = 10 * 24 * 60 * 60 * 1000; // day 10, so every unit has room below it

  it("reads never for a workspace that has no stamp", () => {
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime(null, now)).toBe("never");
  });

  it("reads never for a stamp in the future rather than inventing a countdown", () => {
    expect(relativeTime(now + 60_000, now)).toBe("never");
  });

  it("reads just now below a minute, including the same millisecond", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 59_000, now)).toBe("just now");
  });

  it("steps to minutes, hours, days and weeks at each boundary", () => {
    expect(relativeTime(now - 60_000, now)).toBe("1m ago");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m ago");
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relativeTime(now - 23 * 60 * 60_000, now)).toBe("23h ago");
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
    expect(relativeTime(now - 6 * 24 * 60 * 60_000, now)).toBe("6d ago");
    expect(relativeTime(now - 7 * 24 * 60 * 60_000, now)).toBe("1w ago");
  });

  it("keeps counting in weeks rather than growing a new unit", () => {
    expect(relativeTime(0, 60 * 7 * 24 * 60 * 60_000)).toBe("60w ago");
  });
});

describe("appLinks", () => {
  it("omits a link whose url is null", () => {
    const links: AppLink[] = [
      { id: "a", label: "A", url: "https://example.com" },
      { id: "b", label: "B", url: null },
    ];
    expect(appLinks(links).map((l) => l.id)).toEqual(["a"]);
  });

  it("renders the repo and issue links and holds the website back", () => {
    expect(appLinks().map((l) => l.id)).toEqual(["repo", "issues"]);
  });

  it("ships no link that points nowhere", () => {
    for (const link of appLinks()) {
      expect(link.url).toMatch(/^https:\/\//);
    }
  });

  it("keeps a website slot for the day there is a site", () => {
    expect(APP_LINKS.some((l) => l.id === "website")).toBe(true);
  });
});

describe("workspaceRecapLine", () => {
  function summary(over: Partial<WorkspaceAgentsSummary> = {}): WorkspaceAgentsSummary {
    return { pages: 0, tabs: 0, agents: 0, running: 0, waiting: 0, failed: 0, idle: 0, ...over };
  }

  it("leads with a broken agent, which is the one bucket nobody can leave alone", () => {
    expect(workspaceRecapLine(summary({ failed: 1, running: 2, pages: 4 }))).toBe(
      "1 stopped · 2 running · 4 pages"
    );
  });

  it("leads with what is happening, then how big the workspace is", () => {
    expect(workspaceRecapLine(summary({ running: 2, pages: 4 }))).toBe("2 running · 4 pages");
  });

  it("gives waiting agents their own phrase, after running", () => {
    expect(workspaceRecapLine(summary({ running: 1, waiting: 3, pages: 2 }))).toBe(
      "1 running · 3 waiting · 2 pages"
    );
  });

  it("says nothing about a bucket that is empty", () => {
    expect(workspaceRecapLine(summary({ pages: 3 }))).toBe("3 pages");
    expect(workspaceRecapLine(summary({ waiting: 1, pages: 1 }))).toBe("1 waiting · 1 page");
  });

  it("singularises one page", () => {
    expect(workspaceRecapLine(summary({ pages: 1 }))).toBe("1 page");
  });

  it("says so when a workspace has no pages at all", () => {
    expect(workspaceRecapLine(summary())).toBe("no pages");
    expect(workspaceRecapLine(summary({ running: 1 }))).toBe("1 running · no pages");
  });
});

describe("APP_VERSION", () => {
  it("is the package version, not a placeholder", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
