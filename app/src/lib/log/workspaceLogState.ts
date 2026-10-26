// The Log tab's reach into the daemon: whether the tab can be shown, the
// page reads, the live push, and the clear. The decisions it acts on are
// workspaceLog.ts's; this module only does the talking.
import { get } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { daemonCompat, layoutState } from "$lib/core/layoutState";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import { askConfirm } from "$lib/core/dialog";
import { isSshWorkspace } from "$lib/workspace/sshWorkspace";
import {
  LOG_PAGE_SIZE,
  categoriesForQuery,
  clearConfirm,
  type ClearOption,
  type LogCategory,
  type LogCursor,
  type LogEntry,
  type WorkspaceLogPage,
} from "$lib/log/workspaceLog";

/// Why the tab shows a message instead of the log, or null. An older
/// daemon keeps no log at all, and an empty list would say nothing ever
/// happened here -- so it says to restart instead.
export function workspaceLogBlockedReason(workspaceId: string): string | null {
  const blocked = featureBlockedReason(get(daemonCompat), "workspaceLog");
  if (blocked) return blocked;
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws) return "Unknown workspace";
  if (isSshWorkspace(ws)) return "The Log is kept for this machine's workspaces only, not over ssh";
  if (!ws.rootPath) return "This workspace has no folder";
  return null;
}

/// One page, newest first, strictly older than `before`.
export function readLogPage(
  workspaceId: string,
  before: LogCursor | null,
  on: readonly LogCategory[],
  search: string
): Promise<WorkspaceLogPage> {
  const query = search.trim();
  return backend.workspaceLog(workspaceId, before, LOG_PAGE_SIZE, categoriesForQuery(on), query || null);
}

/// The daemon's push of new entries, for as long as the returned stop is
/// not called. Every workspace's arrive here; the tab keeps its own.
export async function listenForLogEntries(
  onEntries: (workspaceId: string, entries: LogEntry[]) => void
): Promise<() => void> {
  return await listen<[string, LogEntry[]]>("workspace-log-appended", (event) => {
    const [workspaceId, entries] = event.payload;
    onEntries(workspaceId, entries);
  });
}

/// Clears the log back to `option`, after asking. Resolves to an error
/// to show, or null -- for a clear that happened and for one the human
/// declined alike.
export async function clearLog(workspaceId: string, option: ClearOption): Promise<string | null> {
  const ask = clearConfirm(option);
  const confirmed = await askConfirm({ ...ask, danger: true });
  if (!confirmed) return null;
  try {
    await backend.clearWorkspaceLog(workspaceId, option.olderThan);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
