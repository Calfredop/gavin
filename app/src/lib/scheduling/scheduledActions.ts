// What the Scheduled tab and the Schedule dialog DO: each a backend write
// and a re-read of the list. Every one answers with why it did nothing,
// or null.

import { writable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { askConfirm } from "$lib/core/dialog";
import { workspaceRootPath } from "$lib/core/layoutState";
import { ruleLine } from "$lib/scheduling/schedule";
import { refreshScheduled, scheduledBlockedReason } from "$lib/scheduling/scheduledState";
import type { ScheduledTask, ScheduleRule } from "$lib/scheduling/scheduledTask";
import type { CardAgentFields } from "$lib/cards/cardAgent";

/// What the Schedule dialog is open for: a card to copy, a task from
/// scratch, or an existing task's schedule.
export type ScheduleRequest =
  | { mode: "card"; workspaceId: string; cardPath: string; title: string; fields: CardAgentFields }
  | { mode: "new"; workspaceId: string }
  | { mode: "edit"; workspaceId: string; task: ScheduledTask };

/// The open dialog, mounted once by the page.
export const scheduleRequest = writable<ScheduleRequest | null>(null);

/// The task the Scheduled tab should select next -- one just made.
export const scheduledFocus = writable<{ workspaceId: string; path: string } | null>(null);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function attempt(workspaceId: string, write: () => Promise<unknown>): Promise<string | null> {
  const blocked = scheduledBlockedReason(workspaceId);
  if (blocked) return blocked;
  try {
    await write();
  } catch (e) {
    return errorText(e);
  }
  await refreshScheduled(workspaceId);
  return null;
}

/// The dialog's Save. `agent` is the headless agent picked for a task
/// whose own has none, written as `agent:` on the copy.
export async function saveSchedule(
  request: ScheduleRequest,
  rule: ScheduleRule,
  agent: string | null,
  fresh: { title: string; body: string } | null = null
): Promise<string | null> {
  const { workspaceId } = request;
  const root = workspaceRootPath(workspaceId);
  if (!root) return "This workspace has no folder";
  const schedule = ruleLine(rule);
  switch (request.mode) {
    case "card":
    case "new":
      return attempt(workspaceId, async () => {
        const path = await backend.createScheduledTask(workspaceId, root, {
          fromCard: request.mode === "card" ? request.cardPath : undefined,
          title: fresh?.title,
          body: fresh?.body,
          schedule,
          agent: agent ?? undefined,
        });
        scheduledFocus.set({ workspaceId, path });
      });
    case "edit":
      return attempt(workspaceId, async () => {
        await backend.setScheduledTaskField(workspaceId, request.task.path, "schedule", schedule);
        if (agent) await backend.setScheduledTaskField(workspaceId, request.task.path, "agent", agent);
      });
  }
}

export function setPaused(workspaceId: string, task: ScheduledTask, paused: boolean): Promise<string | null> {
  return attempt(workspaceId, () =>
    backend.setScheduledTaskField(workspaceId, task.path, "paused", paused ? "true" : "false")
  );
}

/// Takes the schedule off a task and keeps the task: it stays in the
/// list, runs only when Run now is pressed, and can be scheduled again.
export function unschedule(workspaceId: string, task: ScheduledTask): Promise<string | null> {
  return attempt(workspaceId, () => backend.setScheduledTaskField(workspaceId, task.path, "schedule", ""));
}

export function duplicateScheduled(workspaceId: string, task: ScheduledTask): Promise<string | null> {
  return attempt(workspaceId, async () => {
    const path = await backend.duplicateScheduledTask(workspaceId, task.path);
    scheduledFocus.set({ workspaceId, path });
  });
}

/// Deletes the task, its reports and its run history, once confirmed.
/// The card it was copied from is not touched.
export async function deleteScheduled(workspaceId: string, task: ScheduledTask): Promise<string | null> {
  const confirmed = await askConfirm({
    title: `Delete the Scheduled task “${task.title}”?`,
    lines: [
      "Its Run reports and run history go with it.",
      task.from ? `The card it was copied from (${task.from}) stays where it is.` : "",
    ].filter(Boolean),
    confirmLabel: "Delete task",
    danger: true,
  });
  if (!confirmed) return null;
  return attempt(workspaceId, () => backend.deleteScheduledTask(workspaceId, task.path));
}

/// Opens the Schedule dialog for a card. The menu entry gates kinds; this
/// gates the workspace.
export function requestScheduleCard(
  workspaceId: string,
  card: { id: string; title: string } & CardAgentFields
): string | null {
  const blocked = scheduledBlockedReason(workspaceId);
  if (blocked) return blocked;
  const fields = { agent: card.agent, model: card.model, effort: card.effort, complexity: card.complexity };
  scheduleRequest.set({ mode: "card", workspaceId, cardPath: card.id, title: card.title, fields });
  return null;
}
