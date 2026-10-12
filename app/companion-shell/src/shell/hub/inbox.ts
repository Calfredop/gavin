// The combined attention inbox (spec, "The Workstations hub", story 22):
// what is waiting on the human, on every paired Workstation, in one list,
// each item labelled with its Workstation.
//
// Only a Workstation that answered, and is ready, adds anything. One that
// is locked, connecting, asleep, unreachable, or whose desktop app is not
// running adds nothing: what it said before is no longer known to be
// true, and an item dealt with at the desk must not linger on the phone
// (story 25).
import type { AttentionItem, AttentionKind, AttentionTarget } from "$shell/connection/attention";
import type { PairedWorkstation } from "$shell/hub/paired";
import type { LiveState } from "$shell/hub/live";

export interface InboxRow {
  /// Unique across Workstations: an item id is only unique on its own.
  key: string;
  workstationId: string;
  workstationName: string;
  /// The workspace's id on its Workstation: where tapping the row lands.
  workspace: string;
  /// Its name, when the Workstation said it.
  workspaceName?: string;
  kind: AttentionKind;
  text: string;
  target: AttentionTarget | null;
}

/// In the hub's order -- the Workstations oldest pairing first, each one's
/// items in the order its desk gave them.
export function combinedInbox(
  paired: Array<Pick<PairedWorkstation, "id" | "name">>,
  live: Readonly<Record<string, LiveState>>
): InboxRow[] {
  const rows: InboxRow[] = [];
  const seen = new Set<string>();
  for (const ws of paired) {
    const state = live[ws.id];
    if (state?.state !== "ready") continue;
    for (const item of state.items) {
      const key = `${ws.id}/${item.id}`;
      // A desk that listed an item twice shows it once.
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row(ws, item, key));
    }
  }
  return rows;
}

function row(ws: Pick<PairedWorkstation, "id" | "name">, item: AttentionItem, key: string): InboxRow {
  return {
    key,
    workstationId: ws.id,
    workstationName: ws.name,
    workspace: item.workspace,
    ...(item.workspaceName ? { workspaceName: item.workspaceName } : {}),
    kind: item.kind,
    text: item.text,
    target: item.target,
  };
}

export function kindLabel(kind: AttentionKind): string {
  switch (kind) {
    case "waiting":
      return "Agent waiting";
    case "human-test":
      return "Human test";
    case "failed":
      return "Agent failed";
    case "interrupted":
      return "Agent interrupted";
    case "rail-stopped":
      return "Rail stopped";
    case "other":
      return "Needs you";
  }
}
