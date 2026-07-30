import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LayoutNode } from "./layout";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
}));

import { confirm } from "@tauri-apps/plugin-dialog";
import { layoutState } from "./layoutState";
import { confirmTabClose, confirmPaneClose } from "./confirmClose";

beforeEach(() => {
  vi.clearAllMocks();
});

function setTree(tree: LayoutNode): void {
  layoutState.set({ status: "ready", errorMessage: "", tree, focusedSessionId: null });
}

describe("confirmTabClose", () => {
  it("skips the prompt and resolves true when the tab isn't the last one in its pane", async () => {
    setTree({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 });
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prompts and returns the dialog's answer when the tab is the last one in its pane", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("last one in this pane");
  });

  it("propagates a decline", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await confirmTabClose("a")).toBe(false);
  });
});

describe("confirmPaneClose", () => {
  it("always prompts, even for a single-tab pane, and reports the session count", async () => {
    setTree({ type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmPaneClose("b");
    expect(result).toBe(true);
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("3 terminal sessions");
  });

  it("pluralizes correctly for a single session", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(true);
    await confirmPaneClose("a");
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("1 terminal session ");
  });

  it("propagates a decline", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await confirmPaneClose("a")).toBe(false);
  });
});
