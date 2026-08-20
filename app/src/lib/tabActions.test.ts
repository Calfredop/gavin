import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./confirmClose", () => ({ confirmTabClose: vi.fn() }));
vi.mock("./layoutState", () => ({ closeSession: vi.fn().mockResolvedValue(undefined) }));

import { confirmTabClose } from "./confirmClose";
import { closeSession } from "./layoutState";
import { closeTabs } from "./tabActions";

beforeEach(() => {
  vi.mocked(confirmTabClose).mockReset();
  vi.mocked(closeSession).mockClear();
});

describe("closeTabs", () => {
  it("confirms then closes each tab in order", async () => {
    vi.mocked(confirmTabClose).mockResolvedValue(true);
    await closeTabs(["a", "b"]);
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("stops at the first declined confirm", async () => {
    vi.mocked(confirmTabClose).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await closeTabs(["a", "b", "c"]);
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["a"]);
  });

  it("does nothing for an empty list", async () => {
    await closeTabs([]);
    expect(confirmTabClose).not.toHaveBeenCalled();
  });
});
