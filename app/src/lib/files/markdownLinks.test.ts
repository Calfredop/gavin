import { describe, it, expect } from "vitest";
import { hrefToOpen } from "$lib/files/markdownLinks";
import { source } from "$lib/sources";

// A sanitized <a href> is otherwise a top-level navigation of the gavin
// window. Every markdown sink preventDefaults the click and only http(s)
// leaves, through the system browser (ADR 0005).

describe("hrefToOpen", () => {
  it("returns an http(s) URL to open in the system browser", () => {
    expect(hrefToOpen("https://example.invalid/")).toBe("https://example.invalid/");
    expect(hrefToOpen("http://example.invalid/path")).toBe("http://example.invalid/path");
  });

  it("refuses file:, relative and fragment hrefs", () => {
    expect(hrefToOpen("file:///etc/passwd")).toBeNull();
    expect(hrefToOpen("docs/a.md")).toBeNull();
    expect(hrefToOpen("#fragment")).toBeNull();
    expect(hrefToOpen("javascript:alert(1)")).toBeNull();
  });
});

describe("desktop markdown sinks intercept link clicks", () => {
  it("CardDetailModal's body-preview handles click and auxclick", () => {
    const text = source("CardDetailModal.svelte");
    const preview = /class="body-preview"[^>]*>/.exec(text);
    expect(preview, "body-preview container").not.toBeNull();
    expect(preview![0]).toMatch(/on(?:click|auxclick)=\{/);
    // Both gestures: a plain left click and a middle-click.
    expect(text).toMatch(/class="body-preview"[\s\S]{0,120}onclick=\{/);
    expect(text).toMatch(/class="body-preview"[\s\S]{0,120}onauxclick=\{/);
  });

  it("FileEditor's prose container handles click and auxclick", () => {
    const text = source("FileEditor.svelte");
    expect(text).toMatch(/class="prose"[\s\S]{0,120}onclick=\{/);
    expect(text).toMatch(/class="prose"[\s\S]{0,120}onauxclick=\{/);
  });
});
