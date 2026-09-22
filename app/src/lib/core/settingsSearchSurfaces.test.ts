import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";

// A static pre-flight over the two settings panels (SettingsHubView.svelte,
// GlobalSettingsView.svelte): the search box works by hiding whichever
// <section> a query doesn't match (settingsSearch.ts), driven off a
// hand-written SECTIONS array that is NOT generated from the markup --
// nothing re-derives it, so a section added to one without the other
// silently stops being searchable instead of failing anything. This reads
// the committed source the way tooltipSurfaces.test.ts does (Vite hands
// SSR an empty string for a CSS import, and there is no component-mount
// suite here to catch it at runtime -- see CLAUDE.md's note that rendered
// UI is the one thing the suites cannot cover) and checks the two lists
// stay in lockstep.

interface SectionUse {
  id: string;
  title: string;
}

/// Every `<section hidden={!settingsFilter.visible("id") …}>` immediately
/// followed by its `<h3>` -- the template's own list of searchable
/// sections, in the order they render. The selected-section gate may
/// sit beside the search predicate; the id is still what search drives.
function templateSections(text: string): SectionUse[] {
  const out: SectionUse[] = [];
  const re =
    /<section hidden=\{!settingsFilter\.visible\("([a-z-]+)"\)(?:\s*\|\|\s*selectedSection !== "[a-z-]+")?\}>\s*<h3>([^<]+)<\/h3>/g;
  for (const m of text.matchAll(re)) out.push({ id: m[1], title: m[2] });
  return out;
}

/// Bare `<section>` tags with no search wiring at all -- the thing this
/// test exists to catch.
function unwiredSections(text: string): number {
  const total = (text.match(/<section[ >]/g) ?? []).length;
  const wired = (text.match(/<section hidden=\{!settingsFilter\.visible\(/g) ?? []).length;
  return total - wired;
}

/// The SECTIONS array's own entries, as raw `{ id, block }` slices --
/// crude on purpose, the same tactic tooltipSurfaces.test.ts uses for
/// CSS rules: `block` is everything between one `{ id:` and the next,
/// so a substring check on it is a check on that entry's keywords.
function declaredSections(text: string): { id: string; block: string }[] {
  const body = text.match(/const SECTIONS: SettingsSection\[\] = \[([\s\S]*?)\n {2}\];/);
  expect(body, "SECTIONS array not found in the shape this test expects").not.toBeNull();
  const entries = (body as RegExpMatchArray)[1].split(/\{\s*id:/).slice(1);
  return entries.map((raw) => {
    const id = raw.match(/^\s*"([a-z-]+)"/)?.[1] ?? "";
    return { id, block: raw };
  });
}

function checkFile(file: string): void {
  const text = source(file);
  expect(text, `${file} must drive its search box from settingsSearch.ts`).toMatch(
    /import \{ searchSettings, type SettingsSection \} from "\$lib\/(?:[\w.-]+\/)*settingsSearch"/
  );
  expect(text, `${file} must offer the shared search box`).toMatch(/<SearchInput[\s\S]{0,200}class="settings-search"/);

  expect(unwiredSections(text), `${file} has a <section> not wired to settingsFilter.visible(...)`).toBe(0);

  const used = templateSections(text);
  const declared = declaredSections(text);
  const usedIds = used.map((u) => u.id);
  const declaredIds = declared.map((d) => d.id);

  expect(new Set(usedIds), `${file}: every section id in the template must appear in SECTIONS, and vice versa`).toEqual(
    new Set(declaredIds)
  );
  expect(usedIds.length, `${file}: a section id is used more than once, or SECTIONS has a duplicate`).toBe(
    new Set(usedIds).size
  );

  for (const { id, title } of used) {
    const entry = declared.find((d) => d.id === id);
    expect(entry, `${file}: SECTIONS is missing an entry for "${id}"`).toBeDefined();
    expect(
      (entry as { block: string }).block,
      `${file}: the "${id}" section's own title ("${title}") should be searchable -- add it to that entry's keywords`
    ).toContain(`"${title}"`);
  }
}

describe("settings search stays in lockstep with its panels", () => {
  it("wires every SettingsHubView section to the search box", () => {
    checkFile("SettingsHubView.svelte");
  });

  it("wires every GlobalSettingsView section to the search box", () => {
    checkFile("GlobalSettingsView.svelte");
  });
});

// The by-meaning fallback (settingsSearchFallback.ts), as the strings a
// panel needs for it to run at all. The logic is proven in its own test;
// this is the static pre-flight over the two templates and the copy that
// says what leaves the machine -- the rendered pass is the owner's.
describe("the by-meaning fallback", () => {
  it.each(["SettingsHubView.svelte", "GlobalSettingsView.svelte"])("is wired into %s", (file) => {
    const text = source(file);
    expect(text).toMatch(
      /import \{\s*createSettingsSearchFallback,\s*fallbackAllowed,\s*withClosestMatch,\s*type ClosestMatch,\s*\} from "\$lib\/core\/settingsSearchFallback";/
    );
    // The literal search feeds the box's count, so it keeps reading what
    // the matcher found; the projected one feeds every section's hidden=.
    expect(text).toContain("const literalFilter = $derived(searchSettings(SECTIONS, settingsQuery));");
    expect(text).toContain("matches={literalFilter.filtering ? literalFilter : null}");
    expect(text).toContain(
      "const settingsFilter = $derived(withClosestMatch(literalFilter, closestMatch, settingsQuery));"
    );
    expect(text).toContain("searchFallback.note(SECTIONS, settingsQuery, literalFilter);");
    expect(text).toContain("searchFallback.dispose()");
    // Gated on the turn verdict's toggle and key, through the host command
    // that holds the key.
    expect(text).toContain("ask: backend.typesafeAsk,");
    expect(text).toContain("allowed: () => fallbackAllowed($typesafeSettings),");
    expect(text).toMatch(/import \{ typesafeSettings \} from "\$lib\/agents\/turnVerdictState";/);
    // The line that says it was not a hit.
    expect(text).toContain("{#if settingsFilter.closest}");
    expect(text).toContain(">Closest match<");
    expect(text).toContain(".nav-closest {");
  });

  it("is named in the Turn verdict section's what-leaves-this-machine copy", () => {
    const text = source("GlobalSettingsView.svelte");
    expect(text).toContain("asks the same service when");
    expect(text).toContain("it sends the words in the box and the sections' own keyword");
    expect(text).toContain("nothing from any workspace");
    expect(text).toContain('"Closest match" line, never as a hit');
    // And the section is findable by what it now also governs.
    expect(text).toContain('"settings search",');
    expect(text).toContain('"closest match",');
  });

  it("freezes the question, pins the model and keeps the measured floor", () => {
    const text = source("settingsSearchFallback.ts");
    expect(text).toContain('import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict";');
    expect(text).not.toContain("jev-latest");
    expect(text).toContain("export const FALLBACK_MIN_CONFIDENCE = 0.5;");
    expect(source("backend.ts")).toContain("export function typesafeAsk(request: unknown): Promise<unknown>");
  });
});
