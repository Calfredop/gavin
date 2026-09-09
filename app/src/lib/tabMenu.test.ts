import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/backend", () => ({
  openPathExternally: vi.fn().mockResolvedValue(undefined),
  revealPathExternally: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/layoutState", () => ({
  setTabPinned: vi.fn().mockResolvedValue(undefined),
  splitPane: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  setSessionRead: vi.fn(),
}));
vi.mock("$lib/tabActions", () => ({ closeTabs: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/confirmClose", () => ({ confirmTabClose: vi.fn().mockResolvedValue(true) }));
vi.mock("$lib/cards/bestOfNActions", () => ({ pickCandidate: vi.fn().mockResolvedValue(null) }));

import { openPathExternally, revealPathExternally } from "$lib/backend";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { setTabPinned, splitPane, closeSession, setSessionRead } from "$lib/layoutState";
import { closeTabs } from "$lib/tabActions";
import { buildTabMenuEntries, type TabMenuContext, type TabMenuHooks } from "$lib/tabMenu";
import { bestOfNRuns } from "$lib/cards/bestOfNState";
import { pickCandidate } from "$lib/cards/bestOfNActions";
import { isSeparator, type ContextMenuItem } from "$lib/contextMenu";

function ctx(extra: Partial<TabMenuContext> = {}): TabMenuContext {
  return {
    tabId: "b",
    kind: "terminal",
    path: "/repo",
    pinned: false,
    tabs: ["p", "a", "b", "c"],
    pinnedTabs: ["p"],
    ...extra,
  };
}
function hooks(): TabMenuHooks {
  return { startRename: vi.fn(), reportError: vi.fn() };
}
function items(entries: ReturnType<typeof buildTabMenuEntries>): ContextMenuItem[] {
  return entries.filter((e): e is ContextMenuItem => !isSeparator(e));
}
function find(entries: ReturnType<typeof buildTabMenuEntries>, label: string): ContextMenuItem {
  const item = items(entries).find((e) => e.label === label);
  if (!item) throw new Error(`no entry ${label}`);
  return item;
}

// Lets promise chains started by onPick settle before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildTabMenuEntries", () => {
  it("lists the terminal menu in order", () => {
    expect(items(buildTabMenuEntries(ctx(), hooks())).map((e) => e.label)).toEqual([
      "Close",
      "Close Others",
      "Close to the Right",
      "Close to the Left",
      "Pin",
      "Split Right",
      "Split Down",
      "Rename…",
      "Open Folder in Finder",
      "Copy Path",
    ]);
  });

  it("omits split/rename for file tabs and says Reveal", () => {
    const labels = items(buildTabMenuEntries(ctx({ kind: "file", path: "/repo/a.md" }), hooks())).map((e) => e.label);
    expect(labels).not.toContain("Split Right");
    expect(labels).not.toContain("Rename…");
    expect(labels).toContain("Reveal in Finder");
  });

  it("says Unpin for a pinned tab and pins/unpins through setTabPinned", () => {
    find(buildTabMenuEntries(ctx({ pinned: true }), hooks()), "Unpin").onPick();
    expect(setTabPinned).toHaveBeenCalledWith("b", false);
    find(buildTabMenuEntries(ctx(), hooks()), "Pin").onPick();
    expect(setTabPinned).toHaveBeenCalledWith("b", true);
  });

  it("bulk closes skip pinned tabs and disable when nothing applies", () => {
    const entries = buildTabMenuEntries(ctx(), hooks());
    find(entries, "Close Others").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["a", "c"]);
    find(entries, "Close to the Right").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["c"]);
    find(entries, "Close to the Left").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["a"]);

    const lonely = buildTabMenuEntries(ctx({ tabs: ["p", "b"], tabId: "b" }), hooks());
    expect(find(lonely, "Close Others").disabled).toBe(true);
    expect(find(lonely, "Close to the Right").disabled).toBe(true);
    expect(find(lonely, "Close to the Left").disabled).toBe(true);
  });

  it("Close confirms then closes even a pinned tab", async () => {
    find(buildTabMenuEntries(ctx({ pinned: true }), hooks()), "Close").onPick();
    await flush();
    expect(closeSession).toHaveBeenCalledWith("b");
  });

  it("splits and renames the terminal tab", () => {
    const h = hooks();
    const entries = buildTabMenuEntries(ctx(), h);
    find(entries, "Split Right").onPick();
    expect(splitPane).toHaveBeenCalledWith("b", "row");
    find(entries, "Split Down").onPick();
    expect(splitPane).toHaveBeenCalledWith("b", "column");
    find(entries, "Rename…").onPick();
    expect(h.startRename).toHaveBeenCalledWith("b");
  });

  it("opens folders, reveals files, copies the path", () => {
    find(buildTabMenuEntries(ctx(), hooks()), "Open Folder in Finder").onPick();
    expect(openPathExternally).toHaveBeenCalledWith("/repo");
    find(buildTabMenuEntries(ctx({ kind: "file", path: "/repo/a.md" }), hooks()), "Reveal in Finder").onPick();
    expect(revealPathExternally).toHaveBeenCalledWith("/repo/a.md");
    find(buildTabMenuEntries(ctx(), hooks()), "Copy Path").onPick();
    expect(writeText).toHaveBeenCalledWith("/repo");
  });

  it("disables path items without a path", () => {
    const entries = buildTabMenuEntries(ctx({ path: null }), hooks());
    expect(find(entries, "Open Folder in Finder").disabled).toBe(true);
    expect(find(entries, "Copy Path").disabled).toBe(true);
  });

  it("reports opener failures through the hook", async () => {
    vi.mocked(openPathExternally).mockRejectedValueOnce(new Error("nope"));
    const h = hooks();
    find(buildTabMenuEntries(ctx(), h), "Open Folder in Finder").onPick();
    await flush();
    await flush();
    expect(h.reportError).toHaveBeenCalledWith(expect.stringContaining("nope"));
  });
});

describe("a best-of-N candidate's tab", () => {
  const run = {
    cardPath: "/p/auth.md",
    cardTitle: "Auth",
    pageId: "pg",
    startedAt: 0,
    candidates: ["a", "b", "c"].map((id) => ({
      sessionId: id,
      label: id.toUpperCase(),
      profileId: "claude-code",
      model: "",
      branch: `auth-${id}`,
      worktreePath: `/repos/gavin-auth-${id}`,
      command: "",
      conversationId: null,
    })),
  };

  beforeEach(() => bestOfNRuns.set({}));

  it("offers the pick from the pane, where the run is actually watched", () => {
    bestOfNRuns.set({ "ws-1": [run] });
    const entries = buildTabMenuEntries(ctx(), hooks());
    find(entries, "Keep this candidate, discard the other 2…").onPick();
    expect(pickCandidate).toHaveBeenCalledWith("ws-1", run, "b");
  });

  it("says nothing on a tab that is not in a run", () => {
    const labels = buildTabMenuEntries(ctx(), hooks())
      .filter((e) => !isSeparator(e))
      .map((e) => (e as ContextMenuItem).label);
    expect(labels.join()).not.toContain("Keep this candidate");
  });

  it("says nothing on a file tab that happens to share the id space", () => {
    // File and board tab ids live in the same space as session ids, and a
    // run record is keyed by session id alone.
    bestOfNRuns.set({ "ws-1": [run] });
    const labels = buildTabMenuEntries(ctx({ kind: "file", path: "/repo/a.md" }), hooks())
      .filter((e) => !isSeparator(e))
      .map((e) => (e as ContextMenuItem).label);
    expect(labels.join()).not.toContain("Keep this candidate");
  });
});

// "Mark as Read" -- see sessionRead.ts for why acknowledging a wait is
// deliberately not a status write.
describe("marking a wait as read", () => {
  it("offers the entry beside Pin on a waiting session", () => {
    const labels = items(
      buildTabMenuEntries(ctx({ status: "waiting_for_input" }), hooks())
    ).map((e) => e.label);
    expect(labels.indexOf("Mark as Read")).toBe(labels.indexOf("Pin") + 1);
  });

  it("marks the session the menu was opened on", () => {
    find(buildTabMenuEntries(ctx({ status: "waiting_for_input" }), hooks()), "Mark as Read").onPick();
    expect(setSessionRead).toHaveBeenCalledWith("b", true);
  });

  it("offers the way back once marked, and unmarks", () => {
    // The mark hides the very status the entry is offered for, so it has
    // to stay on the menu -- otherwise a mis-click could only be undone
    // by waiting for the agent to ask something else.
    const entries = buildTabMenuEntries(ctx({ status: "waiting_for_input", read: true }), hooks());
    find(entries, "Mark as Unread").onPick();
    expect(setSessionRead).toHaveBeenCalledWith("b", false);
  });

  it.each(["working", "idle", "failed"] as const)("stays off a %s session", (status) => {
    const labels = items(buildTabMenuEntries(ctx({ status }), hooks())).map((e) => e.label);
    expect(labels.join()).not.toContain("Mark as");
  });

  it("stays off a tab with no session behind it", () => {
    // File, board and card tab ids share the session id space, and a
    // status looked up for one of them can only ever be another tab's.
    const labels = items(
      buildTabMenuEntries(ctx({ kind: "file", path: "/repo/a.md", status: "waiting_for_input" }), hooks())
    ).map((e) => e.label);
    expect(labels.join()).not.toContain("Mark as");
  });
});
