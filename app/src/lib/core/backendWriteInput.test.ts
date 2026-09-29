import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from "@tauri-apps/api/core";
import {
  __resetForTesting as resetMarks,
  isAwaitingFirstSubmit,
  noteReopenedConversation,
} from "$lib/agents/headroomMarkState";
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

// A reopened conversation stays out of the Headroom reach check until a
// line has been submitted to it: typing and pausing is not a turn.
describe("writeInput and a reopened conversation", () => {
  beforeEach(() => {
    resetMarks();
    noteReopenedConversation("s1");
  });

  it("is not submitted by typing, a focus report or a mouse report", async () => {
    await writeInput("s1", "hel");
    await writeInput("s1", "\x1b[I");
    await writeInput("s1", "\x1b[<35;10;5M");
    expect(isAwaitingFirstSubmit("s1")).toBe(true);
  });

  it("is submitted by Enter, alone or ending a paste", async () => {
    await writeInput("s1", "\r");
    expect(isAwaitingFirstSubmit("s1")).toBe(false);
    noteReopenedConversation("s1");
    await writeInput("s1", "\x1b[200~go on\x1b[201~\r");
    expect(isAwaitingFirstSubmit("s1")).toBe(false);
  });
});
