import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/shell/confirmClose", () => ({ confirmTabsClose: vi.fn() }));
vi.mock("$lib/layoutState", () => ({ closeSession: vi.fn().mockResolvedValue(undefined) }));

import { confirmTabsClose } from "$lib/shell/confirmClose";
import { closeSession } from "$lib/layoutState";
import { closeTabs } from "$lib/panes/tabActions";

beforeEach(() => {
  vi.mocked(confirmTabsClose).mockReset();
  vi.mocked(closeSession).mockClear();
});

describe("closeTabs", () => {
  it("confirms once for the batch, then closes each tab in order", async () => {
    vi.mocked(confirmTabsClose).mockResolvedValue(true);
    await closeTabs(["a", "b"]);
    expect(confirmTabsClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirmTabsClose).mock.calls[0][0]).toEqual(["a", "b"]);
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("closes nothing when the batch confirm is declined", async () => {
    vi.mocked(confirmTabsClose).mockResolvedValue(false);
    await closeTabs(["a", "b", "c"]);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("does nothing for an empty list", async () => {
    vi.mocked(confirmTabsClose).mockResolvedValue(true);
    await closeTabs([]);
    expect(closeSession).not.toHaveBeenCalled();
  });
});
