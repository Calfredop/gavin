// The hub's layout, drawn: the Workstations and Pair first, the inbox as
// a count, its totals and the first few with the whole list a screen of
// its own, and the Unlock above everything while it is asked for.
//
// On a physical iPhone 16 Pro with 210 items waiting the hub was one
// scroller 27,063px tall: every item at once, and the Workstations, Pair
// and Unlock 35 screens under them.
import { describe, expect, it } from "vitest";
import { createRawSnippet } from "svelte";
import { render } from "svelte/server";
import type { AttentionItem, AttentionKind } from "$shell/connection/attention";
import { combinedInbox } from "$shell/hub/inbox";
import { PREVIEW_COUNT } from "$shell/hub/inboxView";
import type { LiveState } from "$shell/hub/live";
import type { PairedWorkstation } from "$shell/hub/paired";
import { hubWorkstations } from "$shell/hub/workstations";
import Hub from "$shell/surfaces/Hub.svelte";
import { componentRules } from "$companion/testing/safeArea";

const STUDIO = { id: "studio", name: "Studio Mac", pairedAt: 1 } as PairedWorkstation;
const KINDS: AttentionKind[] = ["human-test", "rail-stopped", "waiting", "failed"];

function items(n: number): AttentionItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    workspace: `w${i % 3}`,
    workspaceName: `Space ${i % 3}`,
    kind: KINDS[i % KINDS.length],
    text: `Item ${i} wants a look`,
    target: { kind: "card", path: `plans/card-${i}.md` },
  }));
}

const KEYS = createRawSnippet(() => ({ render: () => `<section id="keys-panel"></section>` }));

function hub(options: { n?: number; locked?: boolean; listing?: boolean } = {}): string {
  const { n = 210, locked = false, listing = false } = options;
  const live: Record<string, LiveState> = locked ? {} : { [STUDIO.id]: { state: "ready", items: items(n) } };
  return render(Hub, {
    props: {
      workstations: hubWorkstations([STUDIO], live),
      visit: { status: "hub" },
      native: true,
      onOpen: () => {},
      onDismiss: () => {},
      onPair: () => {},
      inbox: locked ? null : combinedInbox([STUDIO], live),
      listing,
      unlockNotice: locked ? { text: "Locked. Unlock to connect to your Workstations.", action: true } : null,
      children: KEYS,
    },
  }).body;
}

/// Where each text first appears, in the order given -- which must be
/// rising for the hub to read in that order.
function positions(html: string, texts: string[]): number[] {
  return texts.map((text) => {
    const at = html.indexOf(text);
    if (at < 0) throw new Error(`the hub does not draw ${JSON.stringify(text)}`);
    return at;
  });
}

const count = (html: string, pattern: RegExp): number => html.match(pattern)?.length ?? 0;
const ITEM = /class="item kind-/g;

describe("the hub, unlocked, with a long inbox", () => {
  const html = hub();

  it("leads with the Workstations and Pair, then what is waiting, then the keys panel", () => {
    const at = positions(html, [
      "Studio Mac",
      "Demo Workstation",
      "Pair a Workstation",
      "210 waiting on you",
      "Show all 210",
      'id="keys-panel"',
    ]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("puts each Workstation's count on its card", () => {
    expect(html).toContain("210 waiting</span>");
  });

  it("shows a count, its totals per kind and the first few items, not the whole inbox", () => {
    expect(html).toContain("53 human tests · 53 rails stopped · 52 agents waiting · 52 agents failed");
    expect(count(html, ITEM)).toBe(PREVIEW_COUNT);
    expect(html).toContain("Item 0 wants a look");
    expect(html).not.toContain(`Item ${PREVIEW_COUNT} wants a look`);
  });

  it("has nothing of the full list's screen until it is asked for", () => {
    expect(html).not.toContain('class="filters');
  });
});

describe("the hub with a short inbox", () => {
  it("shows every item, and no Show all", () => {
    const html = hub({ n: 2 });
    expect(count(html, ITEM)).toBe(2);
    expect(html).not.toContain("Show all");
  });

  it("says when nothing is waiting", () => {
    expect(hub({ n: 0 })).toContain("Nothing is waiting on you.");
  });
});

describe("the whole inbox, on its own screen", () => {
  it("is grouped, filtered by kind with counts, and has the way back to the Workstations", () => {
    const html = hub({ listing: true });
    expect(html).toContain("Waiting on you");
    expect(html).toContain("Workstations</span>");
    expect(html).not.toContain("Pair a Workstation");
    const at = positions(html, ["All <span", "Human tests <span", "Rails stopped <span", "Agents waiting <span", "Agents failed <span"]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toMatch(/<h2 class="group[^"]*"><span class="name[^"]*">Studio Mac<\/span>/);
    expect(html).toMatch(/<h3 class="space[^"]*">Space 0<\/h3>/);
  });

  it("draws a bounded number of rows, however long the inbox", () => {
    const some = count(hub({ n: 210, listing: true }), ITEM);
    const many = count(hub({ n: 5000, listing: true }), ITEM);
    expect(some).toBeGreaterThan(0);
    // One hidden row measures the rest.
    expect(many).toBe(some);
    expect(many).toBeLessThan(40);
  });

  it("gives way to the hub once nothing is waiting", () => {
    const html = hub({ n: 0, listing: true });
    expect(html).toContain("Pair a Workstation");
    expect(html).not.toContain('class="filters');
  });
});

describe("the hub, locked", () => {
  const html = hub({ locked: true });

  it("puts the Unlock above the Workstations and Pair, with no inbox", () => {
    const at = positions(html, ["Locked. Unlock to connect", ">Unlock</button>", "Studio Mac", "Pair a Workstation"]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).not.toContain("waiting on you");
  });

  it("says Unlock once, in the banner, not on every card", () => {
    expect(count(html, /Unlock to connect/g)).toBe(1);
  });

  it("holds the banner at the top of the hub as it scrolls", () => {
    const source = Object.entries(import.meta.glob("./Hub.svelte", { query: "?raw", import: "default", eager: true }));
    const rule = componentRules(Object.fromEntries(source) as Record<string, string>).find((r) =>
      r.selectors.includes(".unlock")
    );
    expect(rule?.declarations.get("position")).toBe("sticky");
    expect(rule?.declarations.get("top")).toBe("0");
  });
});
