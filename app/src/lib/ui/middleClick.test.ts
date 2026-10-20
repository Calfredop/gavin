import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import {
  MIDDLE_CLICK_KEY,
  closesTab,
  loadMiddleClickEnabled,
  middleClickEnabled,
  opensLink,
  saveMiddleClickEnabled,
  setMiddleClickEnabled,
} from "$lib/ui/middleClick";
import { source } from "$lib/sources";

const LEFT = 0;
const MIDDLE = 1;
const RIGHT = 2;

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("opening a terminal link", () => {
  it("opens on a middle press while enabled", () => {
    expect(opensLink({ metaKey: false, button: MIDDLE }, true)).toBe(true);
  });

  it("does not open on a middle press while disabled", () => {
    expect(opensLink({ metaKey: false, button: MIDDLE }, false)).toBe(false);
  });

  // A plain click selects text; it must never start opening things.
  it("never opens on a plain left or right press", () => {
    for (const enabled of [true, false]) {
      expect(opensLink({ metaKey: false, button: LEFT }, enabled)).toBe(false);
      expect(opensLink({ metaKey: false, button: RIGHT }, enabled)).toBe(false);
    }
  });

  it("keeps ⌘-click whether or not middle click is on", () => {
    expect(opensLink({ metaKey: true, button: LEFT }, true)).toBe(true);
    expect(opensLink({ metaKey: true, button: LEFT }, false)).toBe(true);
  });
});

describe("closing a tab", () => {
  it("closes on a middle press while enabled", () => {
    expect(closesTab({ button: MIDDLE }, true)).toBe(true);
  });

  it("does nothing while disabled, or for any other button", () => {
    expect(closesTab({ button: MIDDLE }, false)).toBe(false);
    expect(closesTab({ button: LEFT }, true)).toBe(false);
    expect(closesTab({ button: RIGHT }, true)).toBe(false);
  });
});

describe("remembering the switch", () => {
  it("round-trips through storage", () => {
    const store = storage();
    saveMiddleClickEnabled(false, store);
    expect(store.map.get(MIDDLE_CLICK_KEY)).toBe("false");
    expect(loadMiddleClickEnabled(store)).toBe(false);
    saveMiddleClickEnabled(true, store);
    expect(loadMiddleClickEnabled(store)).toBe(true);
  });

  it("defaults to on, and reads anything it did not write as on", () => {
    expect(loadMiddleClickEnabled(storage())).toBe(true);
    expect(loadMiddleClickEnabled(storage({ [MIDDLE_CLICK_KEY]: "no" }))).toBe(true);
    expect(loadMiddleClickEnabled(undefined)).toBe(true);
  });

  it("survives a storage that throws", () => {
    const hostile = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(loadMiddleClickEnabled(hostile)).toBe(true);
    expect(() => saveMiddleClickEnabled(false, hostile)).not.toThrow();
  });

  it("sets the store", () => {
    setMiddleClickEnabled(false);
    expect(get(middleClickEnabled)).toBe(false);
    setMiddleClickEnabled(true);
    expect(get(middleClickEnabled)).toBe(true);
  });
});

// Static pre-flight over the three surfaces that consume the rule: the
// rendered press is the owner's to try.
describe("the surfaces read the switch", () => {
  it("gates both terminal link kinds on opensLink", () => {
    const text = source("terminalRegistry.ts");
    expect(text).not.toContain("if (!event.metaKey) return;");
    expect(text.match(/if \(!opensLink\(event, get\(middleClickEnabled\)\)\) return;/g)).toHaveLength(2);
  });

  it("closes a pane tab on a middle press, through the same confirm as its close box", () => {
    const text = source("Pane.svelte");
    expect(text).toContain("onauxclick={(e) => void handleTabAuxClick(e, sessionId)}");
    expect(text).toContain("if (!closesTab(e, $middleClickEnabled) || isPinnedTab(sessionId)) return;");
    expect(text).toMatch(/handleTabAuxClick[\s\S]*?if \(await confirmTabClose\(sessionId\)\) closeSession\(sessionId\);/);
  });

  it("offers the switch in Settings", () => {
    const text = source("GlobalSettingsView.svelte");
    expect(text).toContain("checked={$middleClickEnabled}");
    expect(text).toContain("onchange={(e) => setMiddleClickEnabled(e.currentTarget.checked)}");
  });
});
