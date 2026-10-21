<script lang="ts">
  // The Scheduled tab (ADR 0010): this workspace's Scheduled tasks --
  // copies of task cards that run headless on their own schedule -- and
  // what came of each run.
  //
  // A run is silent, so this is where it is read: its live terminal while
  // it goes, borrowed the way the Review tab borrows a card's agent, and
  // afterwards its Run report, with the saved terminal behind it for a
  // run that wrote none. Thin: the rows and controls are scheduledView.ts,
  // the writes scheduledActions.ts, the firing scheduledState.ts.
  import { untrack } from "svelte";
  import { CalendarPlus } from "@lucide/svelte";
  import * as backend from "$lib/core/backend";
  import { layoutState, terminalFontSizeDefault, workspaceRootPath } from "$lib/core/layoutState";
  import { tooltip } from "$lib/core/tooltip";
  import { nowStore } from "$lib/agents/agentPauseState";
  import { sanitizeMarkdown } from "$lib/files/sanitizeMarkdown";
  import TerminalPane from "$lib/terminal/TerminalPane.svelte";
  import ScheduledRow from "$lib/scheduling/ScheduledRow.svelte";
  import { resolveTerminalFontSize } from "$lib/terminal/terminalFont";
  import { liveFire } from "$lib/scheduling/schedule";
  import { refreshScheduled, runScheduledNow, scheduledBlockedReason, scheduledErrors, scheduledTasks } from "$lib/scheduling/scheduledState";
  import {
    deleteScheduled,
    duplicateScheduled,
    scheduledFocus,
    scheduleRequest,
    setPaused,
    unschedule,
  } from "$lib/scheduling/scheduledActions";
  import {
    fireLabel,
    readableFires,
    resolveScheduledSelection,
    scheduledControls,
    scheduledRow,
    sourceCardCandidates,
  } from "$lib/scheduling/scheduledView";
  import type { ScheduledFire, ScheduledTask } from "$lib/scheduling/scheduledTask";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  $effect(() => {
    void refreshScheduled(workspaceId);
  });

  const blocked = $derived(scheduledBlockedReason(workspaceId));
  const tasks = $derived<ScheduledTask[]>($scheduledTasks[workspaceId] ?? []);
  const listError = $derived($scheduledErrors[workspaceId] ?? null);
  const now = $derived(new Date($nowStore));
  const rows = $derived(tasks.map((t) => scheduledRow(t, now)));

  let chosen = $state<string | null>(null);
  $effect(() => {
    const focus = $scheduledFocus;
    if (focus?.workspaceId !== workspaceId) return;
    untrack(() => {
      chosen = focus.path;
      scheduledFocus.set(null);
    });
  });
  const selected = $derived(resolveScheduledSelection(tasks, chosen));
  const task = $derived(tasks.find((t) => t.path === selected) ?? null);
  const controls = $derived(task ? scheduledControls(task) : null);
  const live = $derived(task ? liveFire(task) : null);
  // The run going, by its session: what the terminal below is keyed on.
  const sessionId = $derived(live?.sessionId ?? null);
  const readable = $derived(task ? readableFires(task) : []);

  // What the right side shows: the run going, a report, or the card the
  // task was copied from. A run going is shown by default; otherwise the
  // latest report.
  let pane = $state<"run" | "report" | "card">("report");
  let fireId = $state<number | null>(null);
  let paneFor = $state<string | null>(null);
  $effect(() => {
    const path = selected;
    if (paneFor === path) return;
    untrack(() => {
      paneFor = path;
      pane = live ? "run" : "report";
      fireId = readable[0]?.id ?? null;
      raw = false;
      error = null;
    });
  });
  const fire = $derived<ScheduledFire | null>(readable.find((f) => f.id === fireId) ?? readable[0] ?? null);

  // The report, read when the fire changes. A token, not identity, for
  // the supersession guard: a slow read for the previous fire must not
  // land on this one.
  let report = $state<{ markdown: string | null; raw: string | null } | null>(null);
  let raw = $state(false);
  let reportToken = 0;
  $effect(() => {
    const id = fire?.id ?? null;
    const token = ++reportToken;
    report = null;
    if (id === null) return;
    void backend.scheduledReport(workspaceId, id).then(
      (text) => {
        if (token === reportToken) report = text;
      },
      () => {
        if (token === reportToken) report = { markdown: null, raw: null };
      }
    );
  });
  const reportHtml = $derived(report?.markdown ? sanitizeMarkdown(report.markdown) : null);

  // The source card: on the board, in done/ or archived. "gone" only when
  // no file is left at any of the three.
  let card = $state<{ html: string; path: string } | "gone" | null>(null);
  let cardToken = 0;
  $effect(() => {
    if (pane !== "card" || !task) return;
    const token = ++cardToken;
    card = null;
    const root = workspaceRootPath(workspaceId);
    const candidates = sourceCardCandidates(task.from);
    if (!root || candidates.length === 0) {
      card = "gone";
      return;
    }
    void (async () => {
      try {
        const found = (await backend.attachmentStatus(root, candidates)).find((s) => s.exists && s.absolutePath);
        if (!found?.absolutePath) {
          if (token === cardToken) card = "gone";
          return;
        }
        const file = await backend.readFileForViewer(found.absolutePath);
        if (token === cardToken) {
          card = file.exists ? { html: sanitizeMarkdown(file.content), path: found.path } : "gone";
        }
      } catch {
        if (token === cardToken) card = "gone";
      }
    })();
  });

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const fontSize = $derived(resolveTerminalFontSize(ws?.terminalFontSize, $terminalFontSizeDefault));

  let error = $state<string | null>(null);
  let busy = $state(false);
  async function act(action: () => Promise<string | null>): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      error = await action();
    } finally {
      busy = false;
    }
  }

  function ordinalOf(f: ScheduledFire): number | null {
    if (!task || f.slot === null) return null;
    // Counted fires, oldest first, among those still listed.
    const counted = task.fires.filter((x) => x.slot !== null);
    const at = counted.findIndex((x) => x.id === f.id);
    const n = task.fireCount - at;
    // A fire from before the schedule was changed has no number in this
    // one's count.
    return at < 0 || n < 1 ? null : n;
  }
</script>

{#if blocked}
  <div class="empty">{blocked}</div>
{:else}
  <div class="scheduled">
    <div class="list">
      <div class="list-head">
        <span class="label">Scheduled</span>
        <span class="count">{tasks.length}</span>
        <button
          type="button"
          class="new"
          onclick={() => scheduleRequest.set({ mode: "new", workspaceId })}
          use:tooltip={"Write a Scheduled task from scratch. To schedule a card, use Schedule… on it."}
        >
          <CalendarPlus size={13} /> New scheduled task
        </button>
      </div>
      {#if listError}<p class="err pad">{listError}</p>{/if}
      <div class="rows" role="listbox" aria-label="Scheduled tasks">
        {#if rows.length === 0}
          <div class="none">
            No Scheduled tasks. Schedule… on a task card makes one, and so does New scheduled task.
          </div>
        {/if}
        {#each rows as row (row.path)}
          <ScheduledRow {row} selected={row.path === selected} onPick={() => (chosen = row.path)} />
        {/each}
      </div>
    </div>

    <div class="detail-pane">
      {#if !task || !controls}
        <div class="none">Select a Scheduled task</div>
      {:else}
        <div class="strip">
          <span class="task-title">{task.title}</span>
          <div class="controls">
            <button type="button" disabled={busy} onclick={() => scheduleRequest.set({ mode: "edit", workspaceId, task })}>
              Edit schedule
            </button>
            {#if controls.pauseLabel}
              <button type="button" disabled={busy} onclick={() => act(() => setPaused(workspaceId, task, !task.paused))}>
                {controls.pauseLabel}
              </button>
            {/if}
            <span use:tooltip={controls.runNowBlocked}>
              <button
                type="button"
                disabled={busy || controls.runNowBlocked !== null}
                onclick={() => act(() => runScheduledNow(workspaceId, task))}
                use:tooltip={controls.runNowBlocked ? null : "Run it once now; this run does not count toward the schedule"}
              >
                Run now
              </button>
            </span>
            <button type="button" disabled={readable.length === 0} onclick={() => (pane = "report")}>Open report</button>
            <button type="button" disabled={!task.from} onclick={() => (pane = "card")}>Open card</button>
            <button type="button" disabled={busy} onclick={() => act(() => duplicateScheduled(workspaceId, task))}>
              Duplicate
            </button>
            {#if controls.canUnschedule}
              <button
                type="button"
                disabled={busy}
                onclick={() => act(() => unschedule(workspaceId, task))}
                use:tooltip={"Take the schedule off and keep the task, for Run now"}
              >
                Unschedule
              </button>
            {/if}
            <button type="button" class="danger" disabled={busy} onclick={() => act(() => deleteScheduled(workspaceId, task))}>
              Delete
            </button>
          </div>
        </div>
        {#if error}<p class="err pad">{error}</p>{/if}
        {#if task.scheduleError}<p class="err pad">Unreadable schedule: {task.scheduleError}</p>{/if}

        <div class="modes" role="group" aria-label="What to show">
          <button type="button" class:active={pane === "run"} disabled={!live} onclick={() => (pane = "run")}>Run</button>
          <button type="button" class:active={pane === "report"} onclick={() => (pane = "report")}>Report</button>
          <button type="button" class:active={pane === "card"} disabled={!task.from} onclick={() => (pane = "card")}>Card</button>
        </div>

        <div class="body">
          {#if pane === "run" && sessionId}
            <div class="terminal">
              {#key sessionId}
                <TerminalPane {sessionId} visible={true} focused={false} {fontSize} />
              {/key}
            </div>
          {:else if pane === "run"}
            <div class="none">Starting the run…</div>
          {:else if pane === "card"}
            {#if card === "gone"}
              <div class="none">Open card: gone — {task.from} is no longer in plans/, done/ or the archive.</div>
            {:else if card}
              <p class="hint pad">{card.path}</p>
              <div class="markdown">{@html card.html}</div>
            {:else}
              <div class="none">Reading {task.from}…</div>
            {/if}
          {:else if !fire}
            <div class="none">No run has left a report yet.</div>
          {:else}
            <div class="report-head">
              <span>{fireLabel(fire, ordinalOf(fire), now)}</span>
              {#if fire.exitCode !== null}<span class="hint">exit {fire.exitCode}</span>{/if}
              <label class="raw">
                <input type="checkbox" bind:checked={raw} disabled={!report?.raw} />
                Raw output
              </label>
            </div>
            {#if !report}
              <div class="none">Reading the report…</div>
            {:else if raw || !reportHtml}
              {#if !reportHtml && !raw}<p class="hint pad">No report — the run's saved terminal stands in.</p>{/if}
              <pre class="raw-text">{report.raw ?? "Nothing was saved from this run's terminal."}</pre>
            {:else}
              <div class="markdown">{@html reportHtml}</div>
            {/if}
            {#if readable.length > 1}
              <div class="earlier">
                <span class="label">Earlier reports</span>
                {#each readable as f (f.id)}
                  <button type="button" class:active={f.id === fire.id} onclick={() => { fireId = f.id; raw = false; }}>
                    {fireLabel(f, ordinalOf(f), now)}{f.headline ? ` — ${f.headline}` : ""}
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scheduled {
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--text);
  }
  .empty,
  .none {
    padding: 16px;
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .list-head,
  .strip {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--hub-bar-height);
    box-sizing: border-box;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .label {
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .count {
    font-size: 0.78em;
    color: var(--text-muted);
  }
  .new {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-size: 0.78em;
    padding: 2px 8px;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.danger {
    color: var(--danger-text);
  }
  .rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .detail-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .task-title {
    font-size: 0.9em;
    flex: none;
    max-width: 30%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-left: auto;
    padding: 4px 0;
  }
  .modes {
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .modes button.active,
  .earlier button.active {
    border-color: var(--border-accent);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .terminal {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .report-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 0;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .raw {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .markdown {
    padding: 8px 16px 16px;
    font-size: 0.88em;
    line-height: 1.5;
  }
  .raw-text {
    margin: 8px 12px;
    padding: 8px;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.78em;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .earlier {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 8px 12px 16px;
    border-top: 1px solid var(--border);
  }
  .hint {
    color: var(--text-subtle);
    font-size: 0.78em;
  }
  .err {
    color: var(--danger-text);
    font-size: 0.8em;
  }
  .pad {
    margin: 6px 12px;
  }
</style>
