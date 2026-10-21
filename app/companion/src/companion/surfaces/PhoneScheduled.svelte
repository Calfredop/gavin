<script lang="ts">
  // A workspace's Scheduled tasks on the phone: the desk's own rows
  // (ScheduledRow), opened in place to their controls and their last Run
  // report. A thin template over the desk's scheduledView.ts and
  // scheduledActions.ts, and state/scheduled.ts for what is the phone's
  // own -- Run now asked of the desk. A run going opens its terminal the
  // way the Sessions surface does.
  import { onMount } from "svelte";
  import { SquareTerminal } from "@lucide/svelte";
  import * as backend from "$lib/core/backend";
  import type { Workspace } from "$lib/core/workspace";
  import ScheduledRow from "$lib/scheduling/ScheduledRow.svelte";
  import ScheduleDialog from "$lib/scheduling/ScheduleDialog.svelte";
  import { liveFire } from "$lib/scheduling/schedule";
  import { scheduledBlockedReason, scheduledErrors, scheduledTasks } from "$lib/scheduling/scheduledState";
  import {
    deleteScheduled,
    duplicateScheduled,
    scheduleRequest,
    setPaused,
    unschedule,
  } from "$lib/scheduling/scheduledActions";
  import { fireLabel, readableFires, scheduledControls, scheduledRow } from "$lib/scheduling/scheduledView";
  import type { ScheduledTask } from "$lib/scheduling/scheduledTask";
  import { onReconnect } from "$companion/state/reachability";
  import { listenScheduled, loadScheduled, runNowFromPhone } from "$companion/state/scheduled";
  import { openTerminal } from "$companion/state/workstation";
  import PhoneMarkdown from "$companion/surfaces/PhoneMarkdown.svelte";

  interface Props {
    workspace: Workspace;
  }
  let { workspace }: Props = $props();

  /// The clock rows are read against.
  let now = $state(new Date());
  onMount(() => {
    void loadScheduled(workspace.id);
    const tick = setInterval(() => (now = new Date()), 30_000);
    const stop = onReconnect(() => void loadScheduled(workspace.id));
    let unlisten: (() => void) | null = null;
    void listenScheduled().then((fn) => (unlisten = fn));
    return () => {
      clearInterval(tick);
      stop();
      unlisten?.();
    };
  });

  const blocked = $derived(scheduledBlockedReason(workspace.id));
  const tasks = $derived<ScheduledTask[]>($scheduledTasks[workspace.id] ?? []);
  const listError = $derived($scheduledErrors[workspace.id] ?? null);

  /// The row open in place, by path.
  let expanded = $state<string | null>(null);
  let busy = $state(false);
  let problem = $state<string | null>(null);
  /// The open row's last report, and whether its raw terminal shows.
  let report = $state<{ markdown: string | null; raw: string | null } | null>(null);
  let raw = $state(false);
  let reportToken = 0;

  const open = $derived(tasks.find((t) => t.path === expanded) ?? null);
  const lastReadable = $derived(open ? (readableFires(open)[0] ?? null) : null);
  $effect(() => {
    const id = lastReadable?.id ?? null;
    const token = ++reportToken;
    report = null;
    raw = false;
    if (id === null) return;
    void backend.scheduledReport(workspace.id, id).then(
      (text) => {
        if (token === reportToken) report = text;
      },
      () => {
        if (token === reportToken) report = { markdown: null, raw: null };
      }
    );
  });

  function toggle(path: string): void {
    expanded = expanded === path ? null : path;
    problem = null;
  }

  async function act(action: () => Promise<string | null>): Promise<void> {
    if (busy) return;
    busy = true;
    problem = null;
    try {
      problem = await action();
    } finally {
      busy = false;
    }
  }
</script>

<div class="scheduled">
  {#if blocked}
    <p class="empty">{blocked}</p>
  {:else}
    {#if listError}<p class="problem">The Scheduled tasks could not be read: {listError}</p>{/if}
    {#if tasks.length === 0}
      <p class="empty">No Scheduled tasks. At the desk, Schedule… on a task card makes one.</p>
    {/if}
    <ul class="rows">
      {#each tasks as task (task.path)}
        {@const isOpen = expanded === task.path}
        {@const controls = scheduledControls(task)}
        {@const live = liveFire(task)}
        <li class:open={isOpen}>
          <ScheduledRow row={scheduledRow(task, now)} selected={isOpen} onPick={() => toggle(task.path)} roomy />
          {#if isOpen}
            <div class="detail">
              {#if live?.sessionId}
                <button type="button" class="action" onclick={() => openTerminal(live.sessionId!)}>
                  <SquareTerminal size={16} />
                  <span>Open the run</span>
                </button>
              {/if}
              <div class="controls">
                {#if controls.pauseLabel}
                  <button type="button" class="action" disabled={busy} onclick={() => act(() => setPaused(workspace.id, task, !task.paused))}>
                    {controls.pauseLabel}
                  </button>
                {/if}
                <button
                  type="button"
                  class="action"
                  disabled={busy || controls.runNowBlocked !== null}
                  onclick={() => act(() => runNowFromPhone(workspace.id, task))}
                >
                  Run now
                </button>
                <button
                  type="button"
                  class="action"
                  disabled={busy}
                  onclick={() => scheduleRequest.set({ mode: "edit", workspaceId: workspace.id, task })}
                >
                  Edit schedule
                </button>
                <button type="button" class="action" disabled={busy} onclick={() => act(() => duplicateScheduled(workspace.id, task))}>
                  Duplicate
                </button>
                {#if controls.canUnschedule}
                  <button type="button" class="action" disabled={busy} onclick={() => act(() => unschedule(workspace.id, task))}>
                    Unschedule
                  </button>
                {/if}
                <button type="button" class="action danger" disabled={busy} onclick={() => act(() => deleteScheduled(workspace.id, task))}>
                  Delete
                </button>
              </div>
              {#if controls.runNowBlocked}<p class="meta">{controls.runNowBlocked}</p>{/if}
              {#if problem}<p class="problem" role="alert">{problem}</p>{/if}

              {#if lastReadable}
                <p class="meta">Last report · {fireLabel(lastReadable, null, now)}</p>
                {#if !report}
                  <p class="meta">Reading the report…</p>
                {:else if raw || !report.markdown}
                  {#if !report.markdown}<p class="meta">No report — the run's saved terminal stands in.</p>{/if}
                  <pre class="raw">{report.raw ?? "Nothing was saved from this run's terminal."}</pre>
                {:else}
                  <PhoneMarkdown content={report.markdown} />
                {/if}
                {#if report?.markdown && report.raw}
                  <button type="button" class="action" aria-pressed={raw} onclick={() => (raw = !raw)}>
                    {raw ? "Show the report" : "Raw output"}
                  </button>
                {/if}
              {:else}
                <p class="meta">No run has left a report yet.</p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if $scheduleRequest && $scheduleRequest.workspaceId === workspace.id}
  <ScheduleDialog request={$scheduleRequest} onClose={() => scheduleRequest.set(null)} />
{/if}

<style>
  .scheduled {
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }
  .empty,
  .problem,
  .meta {
    margin: 0;
    padding: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-muted);
    -webkit-user-select: text;
    user-select: text;
  }
  .empty {
    padding: 20px 16px;
  }
  .problem {
    color: var(--danger-text);
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li.open {
    background: var(--surface-sunken);
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 4px 16px 16px;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .action:active {
    background: var(--surface-hover);
  }
  .action:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .action:disabled {
    opacity: 0.45;
  }
  .danger {
    color: var(--danger-text);
  }
  .raw {
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-raised);
    font-size: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
</style>
