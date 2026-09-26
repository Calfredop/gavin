// The reactive half of the tool library: the per-workspace store and its
// persistence. Every decision lives in orchestrationTools.ts; this module
// only holds state and performs effects, the same split orchestration.ts
// and orchestrationState.ts already use.
//
// Deliberately NOT part of orchestrations: a tool outlives every
// arrangement that references it (tools spec T8), and the plan is saved
// wholesale while tools are upserted one at a time.

import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { toolLibrary, toRecord, isBuiltinId, BUILTIN_TOOLS } from "$lib/orchestration/orchestrationTools";
import type { Tool, ToolRecord } from "$lib/orchestration/orchestrationTools";
import { libraryWithPromptOverrides } from "$lib/agents/actionPromptsState";

/// The daemon's rows, by workspace. Null means "not fetched yet", which
/// the scheduler must distinguish from "no tools" -- an unloaded library
/// would otherwise stall every tool step on a cold start.
export const toolRecords = writable<Record<string, ToolRecord[] | null>>({});

export const toolErrors = writable<Record<string, string>>({});

export function dismissToolError(workspaceId: string): void {
  toolErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

/// The whole library for a workspace: built-ins plus its stored rows,
/// with action-prompt overrides applied to agent tool bodies. Null while
/// the fetch is still in flight -- callers pass that null straight
/// through to nextActions, which treats it as "unknown", not "empty".
export function libraryFor(
  records: Record<string, ToolRecord[] | null>,
  workspaceId: string
): Tool[] | null {
  const rows = records[workspaceId];
  if (rows === null || rows === undefined) return null;
  return libraryWithPromptOverrides(toolLibrary(rows), workspaceId);
}

/// The library, or just the built-ins while the fetch is in flight. For
/// RENDERING, where showing the ten tools we ship beats showing nothing.
/// Never use this for the scheduler: it cannot tell loading from empty.
export function renderLibraryFor(
  records: Record<string, ToolRecord[] | null>,
  workspaceId: string
): Tool[] {
  return libraryFor(records, workspaceId) ?? libraryWithPromptOverrides(BUILTIN_TOOLS, workspaceId);
}

/// Loads in flight, by workspace. The scheduler asks for a missing
/// library on every pass, and a pass runs on each emission of ten stores
/// for every loaded workspace -- so without this, the passes that ran
/// while one daemon round trip was on its way would each start another.
const fetching = new Map<string, Promise<void>>();

export async function fetchTools(workspaceId: string): Promise<void> {
  if (workspaceId in get(toolRecords) && get(toolRecords)[workspaceId] !== null) return;
  const inFlight = fetching.get(workspaceId);
  if (inFlight) return inFlight;
  const load = refreshTools(workspaceId).finally(() => fetching.delete(workspaceId));
  fetching.set(workspaceId, load);
  return load;
}

export async function refreshTools(workspaceId: string): Promise<void> {
  try {
    const rows = await backend.getTools(workspaceId);
    toolRecords.update((s) => ({ ...s, [workspaceId]: rows }));
  } catch {
    // Leave it unset; the tab renders the built-ins and the next mount
    // retries. A failed fetch must never look like an empty library.
  }
}

/// An agent authored, edited or deleted one of this workspace's tools
/// over gavin-mcp (v37). The push carries the WHOLE library, exactly what
/// `getTools` answers, so this lands it the same way a fetch would and a
/// client that missed one cannot drift.
///
/// It exists because the assumption below -- that every tool write
/// originates in this app -- stopped being true. `fetchTools` is a
/// load-once, so without this the Tools tab keeps drawing a library
/// missing the tool the agent just made until the whole workspace is
/// reloaded.
///
/// Registered in layoutState.bootstrap beside initOrchestrationListeners,
/// and for the same reason: a Tauri event emitted with no listener is
/// lost, not buffered, so it has to be up before any watchGavinRoot can
/// fire -- and it belongs to the app, not to whichever tab is mounted.
export async function initToolListeners(): Promise<UnlistenFn> {
  return await listen<[string, ToolRecord[]]>("tools-changed", (event) => {
    const [workspaceId, rows] = event.payload;
    toolRecords.update((s) => ({ ...s, [workspaceId]: rows }));
  });
}

/// Every loaded workspace re-reads. A GLOBAL tool saved here belongs to
/// all of them, and an app write gets no push back -- it originates
/// here, so this app is already holding the state. (An AGENT's write
/// does push: see initToolListeners.)
async function refreshEveryWorkspace(): Promise<void> {
  for (const workspaceId of Object.keys(get(toolRecords))) {
    await refreshTools(workspaceId);
  }
}

/// Returns an error string for the dialog, or null. `position` is the
/// current library size, so a new tool lands at the end.
export async function saveToolAction(workspaceId: string, tool: Tool): Promise<string | null> {
  if (tool.scope === "builtin" || isBuiltinId(tool.id)) {
    return "Built-in tools cannot be edited — duplicate this one instead.";
  }
  const existing = get(toolRecords)[workspaceId] ?? [];
  const previous = existing.find((r) => r.id === tool.id);
  const position = previous?.position ?? existing.length;
  let record: ToolRecord;
  try {
    record = toRecord(tool, workspaceId, position);
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  try {
    await backend.saveTool(record);
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  await refreshEveryWorkspace();
  return null;
}

/// Deleting a tool a step still references is DELIBERATELY allowed: that
/// step stalls with "tool is no longer in the library", which the human
/// can see and repair. Refusing the delete would instead make the
/// library hostage to an arrangement they may have forgotten about.
export async function deleteToolAction(workspaceId: string, toolId: string): Promise<string | null> {
  if (isBuiltinId(toolId)) return "Built-in tools cannot be deleted.";
  try {
    await backend.deleteTool(toolId, workspaceId);
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  await refreshEveryWorkspace();
  return null;
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  // First: emptying the store below ticks a running scheduler, which
  // asks for the library again -- and that request has to survive.
  fetching.clear();
  toolRecords.set({});
  toolErrors.set({});
}
