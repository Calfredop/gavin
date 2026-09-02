import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsRight, ChevronUp } from "@lucide/svelte";

// theme.css re-cuts the chevrons with miter joins and butt caps so the
// “>” keeps a point at the 12px the disclosures run at, and it does that
// by naming four `.lucide-chevron-*` classes. Neither end of that is
// self-checking: the icon package chooses the class, and any file may
// import a chevron the rule was never written for. Both go wrong in
// silence -- the icon is simply blunt again, with every suite green.
//
// So this pins the app's side of it: the chevron classes that actually
// reach the DOM are exactly the four theme.css sharpens. The stylesheet
// itself is not readable from here (vite hands SSR an empty string for
// any CSS import), so the selector list below is the mirror to keep in
// step with it.
const SHARPENED = {
  ChevronDown: "lucide-chevron-down",
  ChevronLeft: "lucide-chevron-left",
  ChevronRight: "lucide-chevron-right",
  ChevronUp: "lucide-chevron-up",
  ChevronsRight: "lucide-chevrons-right",
} as const;

/// Every `Chevron*` identifier the app imports from the icon package,
/// mapped to the files that import it -- so a failure names them.
function importedChevrons(): Map<string, string[]> {
  const sources = import.meta.glob("../../**/*.{svelte,ts}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const found = new Map<string, string[]>();
  for (const [path, text] of Object.entries(sources)) {
    if (path.endsWith(".test.ts")) continue;
    for (const block of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@lucide\/svelte["']/g)) {
      for (const specifier of block[1].split(",")) {
        const id = specifier.trim().split(/\s+as\s+/)[0].trim();
        if (!/^Chevrons?[A-Z]/.test(id)) continue;
        found.set(id, [...(found.get(id) ?? []), path]);
      }
    }
  }
  return found;
}

describe("chevron sharpening", () => {
  it("each sharpened chevron renders the class theme.css selects", () => {
    for (const [id, expected] of Object.entries(SHARPENED)) {
      const Icon = { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsRight }[
        id as keyof typeof SHARPENED
      ];
      const classes = [...render(Icon, { props: { size: 12 } }).body.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
        match[1].split(/\s+/),
      );
      expect(classes, `${id} no longer renders ${expected} -- theme.css's selector is dead`).toContain(expected);
    }
  });

  it("the app imports no chevron the rule was not written for", () => {
    const imported = importedChevrons();
    expect(imported.size, "no chevron imports found -- the scan is looking in the wrong place").toBeGreaterThan(0);
    for (const [id, files] of imported) {
      expect(
        Object.keys(SHARPENED),
        `${id} (${files.join(", ")}) is drawn round -- sharpen it in theme.css and list it here`,
      ).toContain(id);
    }
  });
});
