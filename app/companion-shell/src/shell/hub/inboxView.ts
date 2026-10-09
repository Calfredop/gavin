// How the hub shows the combined inbox (`hub/inbox.ts`) without it
// crowding out everything else: a count with the totals per kind, the
// first few items, and the whole list on a screen of its own -- grouped
// by Workstation, then workspace, filtered by kind, and windowed so a
// thousand items are not a thousand live buttons.
//
// On a physical iPhone 16 Pro with 210 items the hub was one scroller
// 27,063px tall, and the Workstations, Pair and Unlock were 35 screens
// down, under every item at once.
import type { AttentionKind } from "$shell/connection/attention";
import type { InboxRow } from "$shell/hub/inbox";

/// The order the totals, and the filters, list the kinds in.
export const KIND_ORDER: readonly AttentionKind[] = [
  "human-test",
  "rail-stopped",
  "waiting",
  "failed",
  "interrupted",
  "other",
];

/// How many items the hub itself shows above `Show all`.
export const PREVIEW_COUNT = 3;

export interface KindTotal {
  kind: AttentionKind;
  count: number;
}

/// Every kind with at least one item, in `KIND_ORDER`.
export function kindTotals(rows: readonly InboxRow[]): KindTotal[] {
  const counts = new Map<AttentionKind, number>();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

/// A kind's name for more than one: a filter's label.
export function kindPlural(kind: AttentionKind): string {
  switch (kind) {
    case "waiting":
      return "Agents waiting";
    case "human-test":
      return "Human tests";
    case "failed":
      return "Agents failed";
    case "interrupted":
      return "Agents interrupted";
    case "rail-stopped":
      return "Rails stopped";
    case "other":
      return "Other";
  }
}

const SINGULAR: Record<AttentionKind, string> = {
  waiting: "agent waiting",
  "human-test": "human test",
  failed: "agent failed",
  interrupted: "agent interrupted",
  "rail-stopped": "rail stopped",
  other: "other",
};

/// "3 human tests", "1 rail stopped".
export function kindCount({ kind, count }: KindTotal): string {
  return `${count} ${count === 1 ? SINGULAR[kind] : kindPlural(kind).toLowerCase()}`;
}

/// The hub's one line under the count: every kind's total.
export function totalsLine(rows: readonly InboxRow[]): string {
  return kindTotals(rows).map(kindCount).join(" · ");
}

/// What the hub shows of the inbox itself: the first `cap` items, and how
/// many `Show all` adds.
export function inboxPreview(rows: readonly InboxRow[], cap = PREVIEW_COUNT): { shown: InboxRow[]; more: number } {
  const shown = rows.slice(0, Math.max(0, cap));
  return { shown, more: rows.length - shown.length };
}

/// One line of the full list: a Workstation's heading, a workspace's, or
/// an item.
export type InboxEntry =
  | { type: "workstation"; key: string; name: string; count: number }
  | { type: "workspace"; key: string; name: string }
  | { type: "item"; key: string; row: InboxRow };

/// The full list, grouped by Workstation, then by workspace, each in the
/// order it first appears (the Workstations oldest pairing first, each
/// one's items in the order its desk gave them). `kind` keeps only that
/// kind. A workspace is headed only when its Workstation named it: an id
/// is no heading.
export function groupedEntries(rows: readonly InboxRow[], kind: AttentionKind | null = null): InboxEntry[] {
  const workstations = new Map<string, { name: string; workspaces: Map<string, InboxRow[]> }>();
  for (const row of rows) {
    if (kind && row.kind !== kind) continue;
    let ws = workstations.get(row.workstationId);
    if (!ws) {
      ws = { name: row.workstationName, workspaces: new Map() };
      workstations.set(row.workstationId, ws);
    }
    const list = ws.workspaces.get(row.workspace);
    if (list) list.push(row);
    else ws.workspaces.set(row.workspace, [row]);
  }
  const entries: InboxEntry[] = [];
  for (const [id, ws] of workstations) {
    let count = 0;
    for (const list of ws.workspaces.values()) count += list.length;
    entries.push({ type: "workstation", key: `ws:${id}`, name: ws.name, count });
    for (const [workspace, list] of ws.workspaces) {
      const name = list.find((row) => row.workspaceName)?.workspaceName;
      if (name) entries.push({ type: "workspace", key: `space:${id}/${workspace}`, name });
      for (const row of list) entries.push({ type: "item", key: row.key, row });
    }
  }
  return entries;
}

/// Where each entry starts in the list, and how tall the whole is: every
/// entry of a type is the same height, the space under it included (an
/// item's text is held to two lines), so a list of any length is laid
/// out without drawing it.
export interface ListLayout {
  offsets: number[];
  heights: number[];
  total: number;
}

export function listLayout(
  entries: readonly InboxEntry[],
  heightOf: Readonly<Record<InboxEntry["type"], number>>
): ListLayout {
  const offsets: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const entry of entries) {
    const height = heightOf[entry.type];
    offsets.push(y);
    heights.push(height);
    y += height;
  }
  return { offsets, heights, total: y };
}

/// The entries to draw for a scroll position: those within `overscan`
/// px of the viewport, so the live rows are bounded by the screen's
/// height, never by the list's length. `[start, end)`.
export function visibleRange(
  layout: ListLayout,
  scrollTop: number,
  viewport: number,
  overscan: number
): { start: number; end: number } {
  const { offsets, heights } = layout;
  const top = scrollTop - overscan;
  const bottom = scrollTop + viewport + overscan;
  // The first entry whose bottom is below `top`.
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] + heights[mid] <= top) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  // The first entry that starts below `bottom`.
  hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < bottom) lo = mid + 1;
    else hi = mid;
  }
  return { start, end: lo };
}
