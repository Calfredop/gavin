import { describe, it, expect } from "vitest";
import { visibleControls } from "$lib/core/visibleControls";

describe("visibleControls", () => {
  it("turns ESC into U+241B and a bidi override into a visible mark", () => {
    expect(visibleControls("say hello\x1b[201~")).toBe("say hello\u{241b}[201~");
    expect(visibleControls("right\u{202e}left")).toBe("right⟨U+202E⟩left");
  });

  it("leaves tab and newline alone", () => {
    expect(visibleControls("a\tb\nc")).toBe("a\tb\nc");
  });
});
