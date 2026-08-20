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

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { setTabPinned, splitPane, closeSession } from "./layoutState";
import { closeTabs } from "./tabActions";
import { buildTabMenuEntries, type TabMenuContext, type TabMenuHooks } from "./tabMenu";
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

beforeEach(() => vi.clearAllMocks());

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
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
    expect(h.reportError).toHaveBeenCalledWith(expect.stringContaining("nope"));
  });
});
