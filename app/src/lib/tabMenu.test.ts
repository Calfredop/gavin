import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./layoutState", () => ({
  setTabPinned: vi.fn().mockResolvedValue(undefined),
  splitPane: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./tabActions", () => ({ closeTabs: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./confirmClose", () => ({ confirmTabClose: vi.fn().mockResolvedValue(true) }));
vi.mock("./bestOfNActions", () => ({ pickCandidate: vi.fn().mockResolvedValue(null) }));

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { setTabPinned, splitPane, closeSession } from "./layoutState";
import { closeTabs } from "./tabActions";
import { buildTabMenuEntries, type TabMenuContext, type TabMenuHooks } from "./tabMenu";
import { bestOfNRuns } from "./bestOfNState";
import { pickCandidate } from "./bestOfNActions";
import { isSeparator, type ContextMenuItem } from "./contextMenu";

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
    expect(openPath).toHaveBeenCalledWith("/repo");
    find(buildTabMenuEntries(ctx({ kind: "file", path: "/repo/a.md" }), hooks()), "Reveal in Finder").onPick();
    expect(revealItemInDir).toHaveBeenCalledWith("/repo/a.md");
    find(buildTabMenuEntries(ctx(), hooks()), "Copy Path").onPick();
    expect(writeText).toHaveBeenCalledWith("/repo");
  });

  it("disables path items without a path", () => {
    const entries = buildTabMenuEntries(ctx({ path: null }), hooks());
    expect(find(entries, "Open Folder in Finder").disabled).toBe(true);
    expect(find(entries, "Copy Path").disabled).toBe(true);
  });

  it("reports opener failures through the hook", async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error("nope"));
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
