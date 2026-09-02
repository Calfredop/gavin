<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { CircleDashed, CircleDot, SquareArrowOutUpRight, TriangleAlert, X } from "@lucide/svelte";
  import * as backend from "./backend";
  import { daemonCompat, layoutState } from "./layoutState";
  import { featureBlockedReason } from "./daemonCompat";
  import {
    formatCpu,
    formatMemory,
    managerSummary,
    sessionRows,
    type ManagedSessions,
    type SessionRow,
  } from "./sessionsManager";
  import { endAllSessions, endSession, jumpToSession } from "./sessionsManagerActions";
  import Modal from "./Modal.svelte";
  import { tooltip } from "./tooltip";

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  /// Two seconds. CPU here is a rate between consecutive polls, so this
  /// interval IS the averaging window: shorter makes every figure jump
  /// with scheduler noise, longer makes a burst of work invisible.
  const POLL_MS = 2000;

  let sample = $state<ManagedSessions | null>(null);
  let previous = $state<ManagedSessions | null>(null);
  let error = $state<string | null>(null);
  /// Nothing has come back yet, so the empty list must not read as "no
  /// sessions" -- which is the one answer a task manager must never give
  /// wrongly.
  let loaded = $state(false);
  let timer: ReturnType<typeof setInterval> | null = null;
  /// Guards against a slow poll landing after a faster later one, and
  /// against one landing after the panel closed. Identity comparison is
  /// no use under Svelte 5's $state proxies, so this is a counter.
  let epoch = 0;

  const rows = $derived(
    sample
      ? sessionRows({
          sample,
          previous,
          workspaces: $layoutState.workspaces,
          sessionNames: $layoutState.sessionNames,
        })
      : []
  );

  const metricsBlocked = $derived(featureBlockedReason($daemonCompat, "sessionMetrics"));

  async function poll(): Promise<void> {
    const mine = ++epoch;
    let next: ManagedSessions;
    try {
      next = await backend.listManagedSessions();
    } catch (e) {
      if (mine !== epoch) return;
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    if (mine !== epoch) return;
    // The rate needs the reading BEFORE this one, so the shift happens
    // here rather than at the top: a failed poll must not become the
    // baseline the next one divides against.
    previous = sample;
    sample = next;
    loaded = true;
    error = null;
  }

  onMount(() => {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  });

  onDestroy(() => {
    // The panel is the only reason the daemon is walking the process
    // table, so closing it has to actually stop.
    epoch += 1;
    if (timer !== null) clearInterval(timer);
  });

  /// Re-polls straight away rather than waiting out the interval, so a
  /// killed row leaves the list at once. The baseline is dropped with it:
  /// the row that just went is not a sample the next rate should divide
  /// against.
  async function refresh(): Promise<void> {
    previous = null;
    await poll();
  }

  async function kill(row: SessionRow): Promise<void> {
    if (await endSession(row)) await refresh();
  }

  async function killAll(): Promise<void> {
    if ((await endAllSessions(rows)) > 0) await refresh();
  }

  async function jump(row: SessionRow): Promise<void> {
    if (await jumpToSession(row)) onClose();
  }

  function place(row: SessionRow): string {
    const parts = [row.workspaceName ?? "no workspace", row.where ?? "no tab"];
    if (row.status === "exited") parts.push("exited");
    else if (row.processCount > 1) parts.push(`${row.processCount} processes`);
    return parts.join(" · ");
  }
</script>

<Modal {onClose} wide>
  <div class="manager">
    <header>
      <h2>Task manager</h2>
      <span class="count">{loaded ? managerSummary(rows) : "reading…"}</span>
      <button
        type="button"
        class="danger"
        disabled={rows.length === 0}
        onclick={() => void killAll()}
      >
        Kill all…
      </button>
    </header>

    {#if error}
      <p class="problem">Couldn’t read the session list: {error}</p>
    {/if}
    {#if metricsBlocked}
      <p class="hint">{metricsBlocked} Until then the list works, but nothing measures what a session is costing.</p>
    {/if}

    {#if loaded && rows.length === 0}
      <p class="hint">No sessions. Nothing is running in any workspace.</p>
    {:else}
      <ul>
        {#each rows as row (row.id)}
          <li class:stale={row.stale} class:survivor={row.staleness === "orphaned"}>
            <!-- Shape carries the question, colour the answer: a triangle
                 for the one case with a live process nobody is hosting, a
                 hollow ring for a row whose run is over, a filled dot for
                 a session that is simply working. -->
            <span class="mark">
              {#if row.staleness === "orphaned"}
                <TriangleAlert size={12} />
              {:else if row.stale}
                <CircleDashed size={12} />
              {:else}
                <CircleDot size={12} />
              {/if}
            </span>
            <span class="label" use:tooltip={row.command ?? row.label}>{row.label}</span>
            <span class="figure">{formatCpu(row.cpuPercent)}</span>
            <span class="figure">{formatMemory(row.memBytes)}</span>
            <span class="actions">
              <button
                type="button"
                use:tooltip={row.visible ? "Go to this session" : "Open this session in a tab"}
                aria-label="Go to this session"
                onclick={() => void jump(row)}
              >
                <SquareArrowOutUpRight size={12} />
              </button>
              <button
                type="button"
                class="danger-icon"
                use:tooltip={"End this session"}
                aria-label="End this session"
                onclick={() => void kill(row)}
              >
                <X size={12} />
              </button>
            </span>
            <span class="place">{place(row)}</span>
            <span class="cwd" use:tooltip={row.cwd}>{row.cwd}</span>
            {#if row.note}
              <p class="note">{row.note}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="foot">
      <p class="hint">
        Every session the daemon is holding, including the ones no tab is showing. CPU is a share of
        one core over the last {POLL_MS / 1000} seconds, across the session’s process and everything
        it started.
      </p>
      <button type="button" onclick={onClose}>Done</button>
    </div>
  </div>
</Modal>

<style>
  /* Deliberately the same type scale and row rhythm as
     GlobalSettingsModal, so the two panels the sidebar footer opens read
     as one family rather than two designs. */
  .manager {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 0.85em;
    width: 100%;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--text);
  }
  .count {
    color: var(--text-subtle);
    flex: 1 1 auto;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  li {
    display: grid;
    /* mark | label | cpu | mem | actions -- the two figures are fixed
       and right-aligned so they stay a column the eye can scan, rather
       than moving with the label beside them. */
    grid-template-columns: 16px minmax(0, 1fr) 62px 76px auto;
    align-items: center;
    column-gap: 8px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
  }
  li:first-child {
    border-top: none;
  }
  li.stale {
    background: var(--surface-warning);
  }
  li.survivor {
    background: var(--surface-danger);
  }
  .mark {
    display: flex;
    color: var(--text-subtle);
  }
  li.stale .mark {
    color: var(--warning-text);
  }
  li.survivor .mark {
    color: var(--danger-text);
  }
  .label {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .figure {
    text-align: right;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: flex;
    gap: 2px;
  }
  .actions button {
    display: flex;
    align-items: center;
    background: none;
    border: none;
    color: var(--text-subtle);
    padding: 2px;
    border-radius: 3px;
    cursor: pointer;
  }
  .actions button:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .actions button.danger-icon:hover {
    color: var(--danger);
  }
  /* The second line: everything that identifies the row rather than
     measuring it, under the label and out of the figure columns. */
  .place,
  .cwd,
  .note {
    grid-column: 2 / -1;
    color: var(--text-subtle);
    margin: 0;
  }
  .place {
    margin-top: 2px;
  }
  .cwd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .note {
    margin-top: 4px;
    color: var(--text-muted);
  }
  .problem {
    margin: 0;
    color: var(--danger);
  }
  .hint {
    color: var(--text-subtle);
    margin: 0;
  }
  .foot {
    display: flex;
    align-items: flex-end;
    gap: 16px;
  }
  .foot .hint {
    flex: 1 1 auto;
  }
  button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.danger:not(:disabled):hover {
    color: var(--danger);
  }
</style>
