import { describe, it, expect } from "vitest";
import { commitColumnDraft, columnComposerKey } from "$lib/board/columnComposer";

describe("commitColumnDraft", () => {
  it("trims the name it files", () => {
    expect(commitColumnDraft("  Blocked  ", false).name).toBe("Blocked");
  });

  // A blank field is the blur route's normal ending: the human opened
  // the composer, thought better of it, and clicked away.
  it("files nothing for an empty or whitespace draft", () => {
    expect(commitColumnDraft("", false).name).toBeNull();
    expect(commitColumnDraft("   ", true).name).toBeNull();
  });

  // Naming columns is one sitting: Enter has to leave the field ready
  // for the next name, and holding focus is what makes that true.
  it("keeps the field open and focused on the Enter route", () => {
    expect(commitColumnDraft("Blocked", true)).toEqual({ name: "Blocked", open: true, refocus: true });
  });

  // The blur route has already lost focus to wherever the human clicked.
  // Taking it back would move their caret out of the field they chose.
  it("closes without refocusing on the blur route", () => {
    expect(commitColumnDraft("Blocked", false)).toEqual({ name: "Blocked", open: false, refocus: false });
  });

  it("closes on a blur even with nothing to file", () => {
    expect(commitColumnDraft("", false)).toEqual({ name: null, open: false, refocus: false });
  });
});

describe("columnComposerKey", () => {
  it("commits on Enter and cancels on Escape", () => {
    expect(columnComposerKey("Enter")).toBe("commit");
    expect(columnComposerKey("Escape")).toBe("cancel");
  });

  it("leaves every other key to the input", () => {
    for (const key of ["a", "Tab", "Backspace", "ArrowDown", " ", "enter"]) {
      expect(columnComposerKey(key)).toBeNull();
    }
  });
});
