// The inbox as the hub shows it: a count with its totals per kind, the
// first few items, and the full list grouped, filtered and windowed.
import { describe, expect, it } from "vitest";
import type { AttentionKind } from "$shell/connection/attention";
import type { InboxRow } from "$shell/hub/inbox";
import {
  PREVIEW_COUNT,
  groupedEntries,
  inboxPreview,
  kindCount,
  kindTotals,
  listLayout,
  totalsLine,
  visibleRange,
} from "$shell/hub/inboxView";

let n = 0;
const row = (overrides: Partial<InboxRow> = {}): InboxRow => {
  n += 1;
  const workstationId = overrides.workstationId ?? "studio";
  return {
    key: `${workstationId}/${n}`,
    workstationId,
    workstationName: workstationId === "studio" ? "Studio" : "Laptop",
    workspace: "w1",
    kind: "waiting",
    text: `item ${n}`,
    target: null,
    ...overrides,
  };
};

describe("the inbox's totals", () => {
  it("counts each kind there is, in one order, and says them in words", () => {
    const rows = [
      row({ kind: "waiting" }),
      row({ kind: "human-test" }),
      row({ kind: "human-test" }),
      row({ kind: "rail-stopped" }),
      row({ kind: "failed" }),
    ];
    expect(kindTotals(rows)).toEqual([
      { kind: "human-test", count: 2 },
      { kind: "rail-stopped", count: 1 },
      { kind: "waiting", count: 1 },
      { kind: "failed", count: 1 },
    ]);
    expect(totalsLine(rows)).toBe("2 human tests · 1 rail stopped · 1 agent waiting · 1 agent failed");
  });

  it("names every kind, one and many", () => {
    const kinds: AttentionKind[] = ["waiting", "human-test", "failed", "interrupted", "rail-stopped", "other"];
    expect(kinds.map((kind) => kindCount({ kind, count: 1 }))).toEqual([
      "1 agent waiting",
      "1 human test",
      "1 agent failed",
      "1 agent interrupted",
      "1 rail stopped",
      "1 other",
    ]);
    expect(kinds.map((kind) => kindCount({ kind, count: 2 }))).toEqual([
      "2 agents waiting",
      "2 human tests",
      "2 agents failed",
      "2 agents interrupted",
      "2 rails stopped",
      "2 other",
    ]);
  });

  it("is empty for an empty inbox", () => {
    expect(kindTotals([])).toEqual([]);
    expect(totalsLine([])).toBe("");
  });
});

describe("the hub's preview of the inbox", () => {
  it("shows the first few and says how many more there are", () => {
    const rows = Array.from({ length: 210 }, () => row());
    const { shown, more } = inboxPreview(rows);
    expect(shown).toEqual(rows.slice(0, PREVIEW_COUNT));
    expect(more).toBe(210 - PREVIEW_COUNT);
  });

  it("shows all of a short inbox, with nothing more", () => {
    const rows = [row(), row()];
    expect(inboxPreview(rows)).toEqual({ shown: rows, more: 0 });
  });
});

describe("the full list", () => {
  it("groups by Workstation, then workspace, each in the order it first appears", () => {
    const a = row({ workstationId: "studio", workspace: "w1", workspaceName: "Gavin" });
    const b = row({ workstationId: "laptop", workspace: "w9", workspaceName: "Notes" });
    const c = row({ workstationId: "studio", workspace: "w2", workspaceName: "Atlas" });
    const d = row({ workstationId: "studio", workspace: "w1", workspaceName: "Gavin" });
    expect(groupedEntries([a, b, c, d]).map((e) => (e.type === "item" ? e.row.key : `${e.type}:${e.name}`))).toEqual([
      "workstation:Studio",
      "workspace:Gavin",
      a.key,
      d.key,
      "workspace:Atlas",
      c.key,
      "workstation:Laptop",
      "workspace:Notes",
      b.key,
    ]);
  });

  it("counts each Workstation's items, under the filter", () => {
    const rows = [row({ kind: "human-test" }), row({ kind: "waiting" }), row({ kind: "human-test", workstationId: "laptop" })];
    expect(groupedEntries(rows).filter((e) => e.type === "workstation").map((e) => e.type === "workstation" && e.count)).toEqual([2, 1]);
    const tests = groupedEntries(rows, "human-test");
    expect(tests.filter((e) => e.type === "item").every((e) => e.type === "item" && e.row.kind === "human-test")).toBe(true);
    expect(tests.filter((e) => e.type === "workstation").map((e) => e.type === "workstation" && e.count)).toEqual([1, 1]);
    expect(groupedEntries(rows, "rail-stopped")).toEqual([]);
  });

  it("heads a workspace only by its name: an id is no heading", () => {
    const rows = [row({ workspace: "79987f60-0c4b" }), row({ workspace: "63040994-a4a2" })];
    expect(groupedEntries(rows).map((e) => e.type)).toEqual(["workstation", "item", "item"]);
  });
});

describe("the full list, windowed", () => {
  const HEIGHTS = { workstation: 40, workspace: 32, item: 88 };
  const rows = Array.from({ length: 1000 }, (_, i) => row({ workspace: `w${i % 4}`, workspaceName: `Space ${i % 4}` }));
  const entries = groupedEntries(rows);
  const layout = listLayout(entries, HEIGHTS);

  it("lays every entry out without drawing it", () => {
    expect(layout.offsets[0]).toBe(0);
    expect(layout.offsets[1]).toBe(40);
    expect(layout.offsets[2]).toBe(72);
    expect(layout.offsets[3]).toBe(72 + 88);
    expect(layout.total).toBe(40 + 4 * 32 + 1000 * 88);
  });

  it("draws only what is near the screen, wherever the list is scrolled", () => {
    for (const scrollTop of [0, 5_000, 40_000, layout.total - 763]) {
      const { start, end } = visibleRange(layout, scrollTop, 763, 763);
      expect(end - start).toBeLessThanOrEqual(Math.ceil((3 * 763) / 88) + 2);
      // Everything on screen is drawn.
      const onScreen = layout.offsets
        .map((top, i) => ({ top, bottom: top + layout.heights[i], i }))
        .filter((e) => e.bottom > scrollTop && e.top < scrollTop + 763);
      expect(onScreen.every((e) => e.i >= start && e.i < end)).toBe(true);
    }
  });

  it("draws nothing for an empty list", () => {
    expect(visibleRange(listLayout([], HEIGHTS), 0, 763, 763)).toEqual({ start: 0, end: 0 });
  });
});
