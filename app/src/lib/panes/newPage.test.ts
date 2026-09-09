import { describe, it, expect } from "vitest";
import {
  NEW_PAGE_TITLE,
  PAGE_PRESETS,
  WITH_AGENT_LABEL,
  newPageEntries,
  type PagePreset,
} from "$lib/panes/newPage";
import { isHeading, isMenuItem, isSeparator, type ContextMenuEntry, type ContextMenuItem } from "$lib/contextMenu";
import { allSessionIds } from "$lib/panes/layout";

/// The entries a caller can actually pick, in order.
function items(entries: ContextMenuEntry[]): ContextMenuItem[] {
  return entries.filter(isMenuItem);
}

describe("PAGE_PRESETS", () => {
  it("builds a tree over exactly the ids its session count asks for", () => {
    for (const preset of PAGE_PRESETS) {
      const ids = Array.from({ length: preset.sessionCount }, (_, i) => `s${i}`);
      expect(allSessionIds(preset.build(ids)).sort()).toEqual([...ids].sort());
    }
  });

  it("has a unique id and a label per entry", () => {
    expect(new Set(PAGE_PRESETS.map((p) => p.id)).size).toBe(PAGE_PRESETS.length);
    expect(PAGE_PRESETS.every((p) => p.label.length > 0)).toBe(true);
  });
});

describe("newPageEntries", () => {
  it("leads with the title, then the agent checkbox, then every preset in table order", () => {
    const entries = newPageEntries(false, () => {}, () => {});
    expect(
      entries.map((e) => (isSeparator(e) ? "--" : isHeading(e) ? `# ${e.heading}` : e.label))
    ).toEqual([`# ${NEW_PAGE_TITLE}`, WITH_AGENT_LABEL, "--", ...PAGE_PRESETS.map((p) => p.label)]);
  });

  // The button that opens this menu is a bare "+" on a tab row now, so
  // the menu is the only place left that says what it makes.
  it("titles itself, since the button no longer carries the words", () => {
    const [first] = newPageEntries(false, () => {}, () => {});
    expect(isHeading(first) && first.heading).toBe(NEW_PAGE_TITLE);
  });

  it("hands the picked preset back whole, so the caller never re-looks it up", () => {
    const picked: PagePreset[] = [];
    const entries = newPageEntries(false, () => {}, (p) => picked.push(p));
    for (const entry of items(entries).slice(1)) entry.onPick();
    expect(picked).toEqual(PAGE_PRESETS);
  });

  // The checkbox qualifies the picks under it, so it has to say which
  // way it is set BEFORE one of them is chosen -- and it must not shut
  // the menu it is a row of, or the tick would never be seen.
  it("draws the checkbox from the state it was given, and keeps the menu open", () => {
    for (const withAgent of [false, true]) {
      const [toggle] = items(newPageEntries(withAgent, () => {}, () => {}));
      expect(toggle.checked).toBe(withAgent);
      expect(toggle.keepOpen).toBe(true);
    }
  });

  it("routes the checkbox to the toggle callback and nothing else", () => {
    let toggles = 0;
    const picked: PagePreset[] = [];
    const [toggle] = items(newPageEntries(false, () => (toggles += 1), (p) => picked.push(p)));
    toggle.onPick();
    expect(toggles).toBe(1);
    expect(picked).toEqual([]);
  });

  // A preset is a plain pick whether the box is ticked or not: one
  // click still adds a page, and the tick only changes what starts in
  // its panes.
  it("leaves the presets as one-click picks that dismiss the menu", () => {
    for (const entry of items(newPageEntries(true, () => {}, () => {})).slice(1)) {
      expect(entry.keepOpen).toBeUndefined();
      expect(entry.checked).toBeUndefined();
    }
  });
});
