import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(""),
}));
vi.mock("$lib/terminal/terminalRegistry", () => ({ getTerminal: vi.fn() }));

import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { getTerminal } from "$lib/terminal/terminalRegistry";
import { copySelection, hasTerminal, pasteClipboard, terminalHasSelection } from "$lib/core/clipboard";

/// Just the calls the clipboard layer makes on an xterm Terminal.
function fakeTerminal(selection: string) {
  return {
    hasSelection: vi.fn(() => selection !== ""),
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(),
    paste: vi.fn(),
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

describe("hasTerminal", () => {
  it("is true for a session with a terminal and false for any other tab", () => {
    withTerminal("");
    expect(hasTerminal("s1")).toBe(true);
    expect(hasTerminal("board-tab")).toBe(false);
  });
});

describe("pasteClipboard", () => {
  it("hands the text to xterm's own paste, which brackets it and turns newlines into Enter", async () => {
    const term = withTerminal("");
    vi.mocked(readText).mockResolvedValueOnce("echo one\necho two");
    await pasteClipboard("s1");
    expect(term.paste).toHaveBeenCalledWith("echo one\necho two");
  });

  it("pastes nothing when the clipboard holds no text", async () => {
    const term = withTerminal("");
    vi.mocked(readText).mockResolvedValueOnce("");
    await pasteClipboard("s1");
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("does not throw when the clipboard cannot be read as text (an image)", async () => {
    const term = withTerminal("");
    vi.mocked(readText).mockRejectedValueOnce("The clipboard contents were not available");
    await expect(pasteClipboard("s1")).resolves.toBeUndefined();
    expect(term.paste).not.toHaveBeenCalled();
  });
});
