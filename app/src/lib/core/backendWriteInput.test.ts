import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from "@tauri-apps/api/core";
import { setOnWriteInputHook, writeInput } from "$lib/core/backend";

// The hook is what dismisses the ↻ restored badge, and it used to fire
// on every write. Claude Code tracks the mouse, so hovering its terminal
// is a stream of writes nobody typed -- and a focus report is one too.
describe("writeInput's hook", () => {
  const hook = vi.fn();
  beforeEach(() => {
    hook.mockClear();
    vi.mocked(invoke).mockClear();
    setOnWriteInputHook(hook);
  });

  it("fires for typing", async () => {
    await writeInput("s1", "x");
    expect(hook).toHaveBeenCalledWith("s1");
  });

  it("stays quiet for a hover, a click and a focus report, which are still written", async () => {
    await writeInput("s1", "\x1b[<35;10;5M");
    await writeInput("s1", "\x1b[<0;10;5M");
    await writeInput("s1", "\x1b[I");
    expect(hook).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenCalledWith("write_input", { sessionId: "s1", data: "\x1b[<35;10;5M" });
  });
});
