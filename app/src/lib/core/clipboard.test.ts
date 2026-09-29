import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(""),
}));
vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return { layoutState: writable({ focusedSessionId: null }) };
});
vi.mock("$lib/core/backend", () => ({ writeInput: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/terminal/terminalRegistry", () => ({ getTerminal: vi.fn() }));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getTerminal } from "$lib/terminal/terminalRegistry";
import { copySelection, terminalHasSelection } from "$lib/core/clipboard";

/// Just the three calls the clipboard layer makes on an xterm Terminal.
function fakeTerminal(selection: string) {
  return {
    hasSelection: vi.fn(() => selection !== ""),
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(),
  };
}

function withTerminal(selection: string) {
  const term = fakeTerminal(selection);
  vi.mocked(getTerminal).mockImplementation((id) =>
    id === "s1" ? (term as unknown as ReturnType<typeof getTerminal>) : undefined
  );
  return term;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTerminal).mockReturnValue(undefined);
});

describe("terminalHasSelection", () => {
  it("is true only for a terminal holding a selection", () => {
    withTerminal("ls -la");
    expect(terminalHasSelection("s1")).toBe(true);
  });

  it("is false for a terminal with nothing selected", () => {
    withTerminal("");
    expect(terminalHasSelection("s1")).toBe(false);
  });

  it("is false for a tab that is not a terminal (board, file, card)", () => {
    withTerminal("ls -la");
    expect(terminalHasSelection("board-tab")).toBe(false);
  });
});

describe("copySelection", () => {
  it("puts the session's selection on the clipboard and leaves it selected", async () => {
    const term = withTerminal("ls -la");
    await copySelection("s1");
    expect(writeText).toHaveBeenCalledWith("ls -la");
    expect(term.clearSelection).not.toHaveBeenCalled();
  });

  it("clears the selection when asked, once the text is taken", async () => {
    const term = withTerminal("ls -la");
    await copySelection("s1", { clear: true });
    expect(writeText).toHaveBeenCalledWith("ls -la");
    expect(term.clearSelection).toHaveBeenCalled();
  });

  it("writes nothing when there is nothing selected", async () => {
    withTerminal("");
    await copySelection("s1", { clear: true });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("writes nothing for a session with no terminal", async () => {
    await copySelection("gone");
    expect(writeText).not.toHaveBeenCalled();
  });
});
