import { describe, it, expect } from "vitest";
import {
  ALL_CLEAR_TIP,
  NEXT_WAITING_TITLE,
  REASON_WORD,
  nextWaitingEntries,
  nextWaitingTip,
  sessionOnScreen,
} from "$lib/agents/nextWaiting";
import { REASON_LABEL, rowTip, type AttentionReason, type AttentionRow } from "$lib/agents/attentionInbox";
import { isHeading, isMenuItem, type ContextMenuEntry, type ContextMenuItem } from "$lib/core/contextMenu";
import type { Page, Workspace } from "$lib/core/workspace";
import type { LayoutNode } from "$lib/panes/layout";

const MINUTE = 60_000;

function row(sessionId: string, overrides: Partial<AttentionRow> = {}): AttentionRow {
  return {
    sessionId,
    workspaceId: "w1",
    workspaceName: "gavin",
    pageId: "p1",
    pageName: "Page 1",
    tabName: `tab ${sessionId}`,
    reason: "asking",
    cardTitle: null,
    cardPath: null,
    cardWorkspaceId: null,
    waitedMs: 5 * MINUTE,
    watched: true,
    failureReason: null,
    ...overrides,
  };
}

function items(entries: ContextMenuEntry[]): ContextMenuItem[] {
  return entries.filter(isMenuItem);
}

describe("nextWaitingEntries", () => {
  it("leads with the hub panel's own heading, then one row per session in inbox order", () => {
    const rows = [row("a"), row("b"), row("c")];
    const entries = nextWaitingEntries(rows, null, () => {});
    expect(isHeading(entries[0]) && entries[0].heading).toBe(NEXT_WAITING_TITLE);
    expect(items(entries).map((i) => i.label)).toEqual(["tab a", "tab b", "tab c"]);
  });

  it("jumps to the row's own session when picked", () => {
    const picked: string[] = [];
    const rows = [row("a"), row("b")];
    items(nextWaitingEntries(rows, null, (r) => picked.push(r.sessionId)))[1].onPick();
    expect(picked).toEqual(["b"]);
  });

  // Every row in one workspace is the common case, and naming it on each
  // row would spend the menu's narrow width on the word they all share.
  it("names the workspace only when the list spans more than one", () => {
    const one = nextWaitingEntries([row("a"), row("b")], null, () => {});
    expect(items(one).map((i) => i.label)).toEqual(["tab a", "tab b"]);

    const two = nextWaitingEntries(
      [row("a"), row("b", { workspaceId: "w2", workspaceName: "site" })],
      null,
      () => {}
    );
    expect(items(two).map((i) => i.label)).toEqual(["gavin · tab a", "site · tab b"]);
  });

  it("carries the reason and the wait in the detail column, the inbox's own wait label included", () => {
    const entries = nextWaitingEntries(
      [
        row("a", { reason: "failed", waitedMs: 2 * 60 * MINUTE }),
        row("b", { waitedMs: 12 * MINUTE, watched: false }),
      ],
      null,
      () => {}
    );
    expect(items(entries).map((i) => i.detail)).toEqual(["failed · 2h", "asking · ≥12m"]);
  });

  // The short word is for the column; the hub's full sentence is not
  // lost, it moves into the row's bubble.
  it("puts the inbox row's full sentence in the bubble", () => {
    const r = row("a", { reason: "failed", failureReason: "API Error: 529" });
    const [item] = items(nextWaitingEntries([r], null, () => {}));
    expect(item.tip).toBe(rowTip(r));
    expect(item.tip).toContain(REASON_LABEL.failed);
    expect(item.tip).toContain("API Error: 529");
  });

  it("marks the session already on screen without moving it", () => {
    const entries = nextWaitingEntries([row("a"), row("b"), row("c")], "b", () => {});
    expect(items(entries).map((i) => [i.label, i.active])).toEqual([
      ["tab a", false],
      ["tab b", true],
      ["tab c", false],
    ]);
  });

  // openContextMenu refuses a menu of nothing but a heading, so an empty
  // inbox cannot open an empty menu even if the button were not
  // disabled.
  it("offers nothing to pick for an empty inbox", () => {
    expect(items(nextWaitingEntries([], null, () => {}))).toEqual([]);
  });
});

describe("REASON_WORD", () => {
  it("has a short word for every reason the inbox can list", () => {
    const reasons = Object.keys(REASON_LABEL) as AttentionReason[];
    expect(Object.keys(REASON_WORD).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect(REASON_WORD[reason].length).toBeLessThan(REASON_LABEL[reason].length);
    }
  });
});

describe("nextWaitingTip", () => {
  it("counts what is waiting, and says the hub's own words when nothing is", () => {
    expect(nextWaitingTip([])).toBe(ALL_CLEAR_TIP);
    expect(ALL_CLEAR_TIP).toBe("Nothing is waiting on you");
    expect(nextWaitingTip([row("a")])).toBe("1 session waiting on you");
    expect(nextWaitingTip([row("a"), row("b")])).toBe("2 sessions waiting on you");
  });
});

describe("sessionOnScreen", () => {
  const tree: LayoutNode = {
    type: "split",
    direction: "row",
    children: [
      { type: "leaf", tabs: ["s1", "s2"], activeTabIndex: 0 },
      { type: "leaf", tabs: ["s3"], activeTabIndex: 0 },
    ],
    sizes: [0.5, 0.5],
  };
  const page: Page = { id: "p1", name: "Page 1", layout: tree, focusedSessionId: null };
  const ws: Workspace = { id: "w1", name: "gavin", pages: [page], activePageId: "p1", mainSessionId: "home" };

  it("is the focused session on the terminal view", () => {
    expect(sessionOnScreen(ws, "terminal", tree, "s3")).toBe("s3");
  });

  // The focus is remembered across page switches; a session on another
  // page is not on screen, and the dot must not say it is.
  it("is nothing when the focused session is not on the page being shown", () => {
    expect(sessionOnScreen(ws, "terminal", tree, "elsewhere")).toBeNull();
    expect(sessionOnScreen(ws, "terminal", null, "s1")).toBeNull();
    expect(sessionOnScreen(ws, "terminal", tree, null)).toBeNull();
  });

  it("is the workspace's own agent on the Home tab", () => {
    expect(sessionOnScreen(ws, "home", tree, "s1")).toBe("home");
    expect(sessionOnScreen({ ...ws, mainSessionId: undefined }, "home", tree, "s1")).toBeNull();
  });

  it("is nothing on every other tab, and with no workspace", () => {
    expect(sessionOnScreen(ws, "kanban", tree, "s1")).toBeNull();
    expect(sessionOnScreen(null, "terminal", tree, "s1")).toBeNull();
  });
});
