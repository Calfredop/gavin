// The reactive half of the group-template library: the per-workspace
// store and its persistence. Every decision lives in
// orchestrationGroups.ts; this module only holds state and performs
// effects, the same split orchestration.ts and orchestrationState.ts
// already use (and toolsState.ts already applies to tools).
//
// Deliberately NOT part of orchestrations: a template outlives every
// arrangement that references it, and the plan is saved wholesale while
// templates are upserted one at a time.

import { writable, get } from "svelte/store";
import * as backend from "$lib/backend";
import { templateLibrary, toTemplateRecord } from "$lib/orchestration/orchestrationGroups";
import type { GroupTemplate, GroupTemplateRecord } from "$lib/orchestration/orchestrationGroups";

/// The daemon's rows, by workspace. Null means "not fetched yet". Unlike
/// the tool library there is no built-in fallback to render meanwhile: a
/// workspace with no templates and a workspace whose templates have not
/// loaded look the same, and showing an empty Groups section for a beat
/// is honest.
export const groupTemplateRecords = writable<Record<string, GroupTemplateRecord[] | null>>({});

export const groupTemplateErrors = writable<Record<string, string>>({});

export function dismissGroupTemplateError(workspaceId: string): void {
  groupTemplateErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

/// The whole library for a workspace: its stored rows plus every global
/// one. Null while the fetch is still in flight, distinguishing "not
/// fetched yet" from "fetched, empty".
export function libraryFor(
  records: Record<string, GroupTemplateRecord[] | null>,
  workspaceId: string
): GroupTemplate[] | null {
  const rows = records[workspaceId];
  return rows === null || rows === undefined ? null : templateLibrary(rows);
}

export async function fetchGroupTemplates(workspaceId: string): Promise<void> {
  if (workspaceId in get(groupTemplateRecords) && get(groupTemplateRecords)[workspaceId] !== null) return;
  await refreshGroupTemplates(workspaceId);
}

export async function refreshGroupTemplates(workspaceId: string): Promise<void> {
  try {
    const rows = await backend.getGroupTemplates(workspaceId);
    groupTemplateRecords.update((s) => ({ ...s, [workspaceId]: rows }));
  } catch {
    // Leave it unset; the drawer renders nothing yet and the next mount
    // retries. A failed fetch must never look like an empty library.
  }
}

/// Every loaded workspace re-reads. A GLOBAL template saved here belongs
/// to all of them, and there is no push for template writes -- they
/// always originate in this app.
async function refreshEveryWorkspace(): Promise<void> {
  for (const workspaceId of Object.keys(get(groupTemplateRecords))) {
    await refreshGroupTemplates(workspaceId);
  }
}

/// Returns an error string for the form, or null. `position` is the
/// current library size, so a new template lands at the end. Unlike
/// saveToolAction there is no isBuiltinId guard: there are no built-in
/// templates, so nothing here can ever collide with one.
export async function saveGroupTemplateAction(
  workspaceId: string,
  template: GroupTemplate
): Promise<string | null> {
  const existing = get(groupTemplateRecords)[workspaceId] ?? [];
  const previous = existing.find((r) => r.id === template.id);
  const position = previous?.position ?? existing.length;
  let record: GroupTemplateRecord;
  try {
    record = toTemplateRecord(template, workspaceId, position);
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  try {
    await backend.saveGroupTemplate(record);
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  await refreshEveryWorkspace();
  return null;
}

/// Unlike deleteToolAction, no isBuiltinId guard (there are no built-in
/// templates) and no "still referenced" concern: placing a template
/// COPIES its steps (stepsFromTemplate mints fresh ids), so no placed
/// step points back at the template it came from -- there is nothing
/// downstream to warn about.
export async function deleteGroupTemplateAction(
  workspaceId: string,
  templateId: string
): Promise<string | null> {
  try {
    await backend.deleteGroupTemplate(templateId);
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  await refreshEveryWorkspace();
  return null;
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  groupTemplateRecords.set({});
  groupTemplateErrors.set({});
}
