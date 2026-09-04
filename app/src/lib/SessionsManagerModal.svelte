<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    ChevronDown,
    ChevronUp,
    CircleDashed,
    CircleDot,
    SquareArrowOutUpRight,
    TriangleAlert,
    X,
  } from "@lucide/svelte";
  import * as backend from "./backend";
  import { daemonCompat, layoutState } from "./layoutState";
  import { featureBlockedReason } from "./daemonCompat";
  import { cmdHeld, isMacSync } from "./platform";
  import {
    DEFAULT_SORT,
    NO_SELECTION,
    formatCpu,
    formatMemory,
    managerSummary,
    nextSort,
    selectRow,
    selectedRows,
    selectionHint,
    sessionRows,
    sortRows,
    totalUsage,
    totalsCoverage,
    totalsNote,
    type ManagedSessions,
    type Selection,
    type SessionRow,
    type SortKey,
    type SortOrder,
  } from "./sessionsManager";
  import {
    endAllSessions,
    endSelectedSessions,
    endSession,
    endStaleSessions,
    jumpToSession,
    restartDaemon,
  } from "./sessionsManagerActions";
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

  const isMac = isMacSync();

  let sample = $state<ManagedSessions | null>(null);
  let previous = $state<ManagedSessions | null>(null);
  let error = $state<string | null>(null);
  /// Nothing has come back yet, so the empty list must not read as "no
  /// sessions" -- which is the one answer a task manager must never give
  /// wrongly.
  let loaded = $state(false);
  let sort = $state<SortOrder>(DEFAULT_SORT);
  /// Ids, not rows: the rows are rebuilt on every poll, and what the
  /// human picked has to survive that.
  let selection = $state<Selection>(NO_SELECTION);
  let timer: ReturnType<typeof setInterval> | null = null;
  /// True only while the daemon is actually away -- set once the human
  /// has confirmed, not when the button is pressed. It both labels the
  /// button and stops the poll below.
  let restarting = $state(false);
  /// When the last restart from this panel finished, so the human can
  /// tell a list of fresh shells from a list that never moved.
  let restartedAt = $state<string | null>(null);
  /// Guards against a slow poll landing after a faster later one, and
  /// against one landing after the panel closed. Identity comparison is
  /// no use under Svelte 5's $state proxies, so this is a counter.
  let epoch = 0;

  const rows = $derived(
    sample
      ? sortRows(
          sessionRows({
            sample,
            previous,
            workspaces: $layoutState.workspaces,
            sessionNames: $layoutState.sessionNames,
          }),
          sort
        )
      : []
  );
  /// Derived rather than pruned in an effect: a row killed or gone
  /// between polls simply stops being counted, with no state write.
  const picked = $derived(selectedRows(rows, selection));
  const pickedIds = $derived(new Set(picked.map((r) => r.id)));
  const staleCount = $derived(rows.filter((r) => r.stale).length);
  /// What the list adds up to, from the same rows the grid is drawing --
  /// so the bottom line can never describe a different sample than the
  /// rows above it.
  const total = $derived(totalUsage(rows));

  const metricsBlocked = $derived(featureBlockedReason($daemonCompat, "sessionMetrics"));

  async function poll(): Promise<void> {
    // Nothing may ask the daemon anything while it is being replaced:
    // the socket is closed and re-made underneath this panel, and a poll
    // landing in that window would report the restart as "couldn't read
    // the session list". The interval keeps firing; this is what makes
    // those ticks nothing.
    if (restarting) return;
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

  async function killSelected(): Promise<void> {
    if ((await endSelectedSessions(picked)) > 0) {
      selection = NO_SELECTION;
      await refresh();
    }
  }

  async function clearStale(): Promise<void> {
    if ((await endStaleSessions(rows)) > 0) await refresh();
  }

  /// Restarting is the one action here that takes the daemon away, so
  /// the poll is stopped for as long as it is gone. Both halves of that
  /// happen in the confirmed callback, never at the click: the flag also
  /// labels the button, and a button that reads "Restarting…" while a
  /// dialog is still asking whether to restart is a button that lies.
  ///
  /// The epoch bump goes with it, so a reply already in flight is
  /// discarded rather than surfacing as an error the human would read as
  /// the restart having failed.
  ///
  /// `refresh` afterwards, not `poll`: every session on the other side is
  /// a brand new process, so the CPU counter this panel was dividing
  /// against belongs to something that no longer exists. It runs on the
  /// failure path too -- a restart that went wrong leaves this list
  /// describing a daemon that may not be there, and the honest thing is
  /// to go and look.
  async function restart(): Promise<void> {
    if (restarting) return;
    let began = false;
    try {
      const restarted = await restartDaemon(rows, $daemonCompat, () => {
        began = true;
        epoch += 1;
        restarting = true;
        // Dropped up front: a restart that then fails must not leave an
        // earlier one's timestamp standing as if it described this list.
        restartedAt = null;
      });
      if (restarted) restartedAt = new Date().toLocaleTimeString();
    } finally {
      restarting = false;
    }
    if (began) await refresh();
  }

  async function jump(row: SessionRow): Promise<void> {
    if (await jumpToSession(row)) onClose();
  }

  function pick(row: SessionRow, e: MouseEvent): void {
    selection = selectRow(
      selection,
      rows.map((r) => r.id),
      row.id,
      { shift: e.shiftKey, cmd: cmdHeld(e) }
    );
  }

  /// A click on the grid's own background -- below the last row -- lets
  /// go of everything, the one gesture a list needs that a modal has no
  /// empty desktop for.
  function clearPick(e: MouseEvent): void {
    if (e.target === e.currentTarget) selection = NO_SELECTION;
  }

  function sortBy(key: SortKey): void {
    sort = nextSort(sort, key);
  }

  function ariaSort(key: SortKey): "ascending" | "descending" | undefined {
    if (sort.key !== key) return undefined;
    return sort.dir === "asc" ? "ascending" : "descending";
  }

  function place(row: SessionRow): string {
    return `${row.workspaceName ?? "no workspace"} · ${row.where ?? "no tab"}`;
  }

  /// What the name cell says on hover: the command when the label is not
  /// already it, then the folder -- the two facts the grid has no column
  /// for.
  function detail(row: SessionRow): string {
    const command = row.command?.trim();
    return command && command !== row.label ? `${command}\n${row.cwd}` : row.cwd;
  }

  function processes(row: SessionRow): string {
    if (row.processCount === 0) return "Nothing running to measure";
    return `${row.processCount} ${row.processCount === 1 ? "process" : "processes"} in this session’s tree`;
  }
</script>

{#snippet heading(key: SortKey, label: string)}
  <button type="button" class="sort" class:active={sort.key === key} onclick={() => sortBy(key)}>
    {label}
    {#if sort.key === key}
      {#if sort.dir === "asc"}
        <ChevronUp size={10} />
      {:else}
        <ChevronDown size={10} />
      {/if}
    {/if}
  </button>
{/snippet}

<Modal {onClose} wide innerScroll>
  <div class="manager">
    <header>
      <h2>Task manager</h2>
      <span class="count">{loaded ? managerSummary(rows) : "reading…"}</span>
      <button type="button" disabled={staleCount === 0} onclick={() => void clearStale()}>
        Clear stale{staleCount > 0 ? ` (${staleCount})` : ""}
      </button>
      <button
        type="button"
        class="danger"
        disabled={picked.length === 0}
        onclick={() => void killSelected()}
      >
        Kill {picked.length > 0 ? `${picked.length} ` : ""}selected…
      </button>
      <button
        type="button"
        class="danger"
        disabled={rows.length === 0}
        onclick={() => void killAll()}
      >
        Kill all…
      </button>
      <!-- Last and set apart: the three buttons before it act on rows in
           this list, this one replaces the process that owns every one
           of them. -->
      <button
        type="button"
        class="danger apart"
        disabled={restarting}
        use:tooltip={"Restart gavin-daemon — every session comes back as a fresh shell"}
        onclick={() => void restart()}
      >
        {restarting ? "Restarting…" : "Restart daemon…"}
      </button>
    </header>

    {#if error}
      <p class="problem">Couldn’t read the session list: {error}</p>
    {/if}
    {#if restartedAt}
      <p class="hint">Daemon restarted at {restartedAt}. Every session below is a fresh shell.</p>
    {/if}
    {#if metricsBlocked}
      <p class="hint">{metricsBlocked} Until then the list works, but nothing measures what a session is costing.</p>
    {/if}

    {#if loaded && rows.length === 0}
      <p class="hint">No sessions. Nothing is running in any workspace.</p>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="grid" onclick={clearPick}>
        <table>
          <colgroup>
            <col class="c-mark" />
            <col />
            <col class="c-state" />
            <col class="c-where" />
            <col class="c-cpu" />
            <col class="c-mem" />
            <col class="c-actions" />
          </colgroup>
          <thead>
            <tr>
              <th></th>
              <th aria-sort={ariaSort("name")}>{@render heading("name", "Name")}</th>
              <th aria-sort={ariaSort("state")}>{@render heading("state", "State")}</th>
              <th>Where</th>
              <th class="num">CPU</th>
              <th class="num" aria-sort={ariaSort("mem")}>{@render heading("mem", "Mem")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.id)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <tr
                class:selected={pickedIds.has(row.id)}
                class:stale={row.stale}
                class:survivor={row.staleness === "orphaned"}
                aria-selected={pickedIds.has(row.id)}
                onclick={(e) => pick(row, e)}
              >
                <!-- Shape carries the question, colour the answer: a
                     triangle for the one case with a live process nobody
                     is hosting, a hollow ring for a row whose run is over,
                     a filled dot for a session that is simply working. -->
                <td class="mark">
                  {#if row.staleness === "orphaned"}
                    <TriangleAlert size={12} />
                  {:else if row.stale}
                    <CircleDashed size={12} />
                  {:else}
                    <CircleDot size={12} />
                  {/if}
                </td>
                <td class="name">
                  <span class="label" use:tooltip={detail(row)}>{row.label}</span>
                  {#if row.note}
                    <p class="note">{row.note}</p>
                  {/if}
                </td>
                <td class="state">{row.state}</td>
                <td class="where" use:tooltip={place(row)}>{place(row)}</td>
                <td class="figure">{formatCpu(row.cpuPercent)}</td>
                <td class="figure" use:tooltip={processes(row)}>{formatMemory(row.memBytes)}</td>
                <td class="actions">
                  <button
                    type="button"
                    use:tooltip={row.visible ? "Go to this session" : "Open this session in a tab"}
                    aria-label="Go to this session"
                    onclick={(e) => {
                      e.stopPropagation();
                      void jump(row);
                    }}
                  >
                    <SquareArrowOutUpRight size={12} />
                  </button>
                  <button
                    type="button"
                    class="danger-icon"
                    use:tooltip={"End this session"}
                    aria-label="End this session"
                    onclick={(e) => {
                      e.stopPropagation();
                      void kill(row);
                    }}
                  >
                    <X size={12} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
          <!-- Inside the table, not under it: with `table-layout: fixed`
               this is the only way the two sums stay in the columns they
               are sums of, whatever the grid's scrollbar does to the
               width. It sticks to the bottom for the same reason the
               headings stick to the top -- what the list costs in total
               must not scroll away with the rows. -->
          <tfoot>
            <tr>
              <td class="mark"></td>
              <td class="total" colspan="3" use:tooltip={totalsNote(total)}>
                <span class="word">Total</span>
                <span class="cover">{totalsCoverage(total)}</span>
              </td>
              <td class="figure">{formatCpu(total.cpuPercent)}</td>
              <td class="figure">{formatMemory(total.memBytes)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    {/if}

    <div class="foot">
      <div class="hints">
        <p class="hint">
          Every session the daemon is holding, including the ones no tab is showing. CPU is a share
          of one core over the last {POLL_MS / 1000} seconds, across the session’s process and
          everything it started.
        </p>
        <p class="keys">{selectionHint(isMac)}</p>
      </div>
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
    /* The modal hands its height down (innerScroll); the grid is the
       one child allowed to give way, so the header and the foot keep
       their place while it scrolls. */
    flex: 1 1 auto;
    min-height: 0;
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
  .grid {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    /* Fixed, so the figure columns stay a column the eye can scan
       rather than moving with the longest name beside them. */
    table-layout: fixed;
  }
  .c-mark {
    width: 26px;
  }
  .c-state {
    width: 96px;
  }
  .c-where {
    width: 26%;
  }
  .c-cpu {
    width: 64px;
  }
  .c-mem {
    width: 78px;
  }
  .c-actions {
    width: 58px;
  }
  th,
  td {
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  }
  thead th {
    /* Stays put while the rows scroll under it: the sort it names has
       to be visible for the order below to be readable. */
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface-raised);
    border-bottom: 1px solid var(--border);
    color: var(--text-subtle);
    font-weight: normal;
    padding-top: 5px;
    padding-bottom: 5px;
  }
  th.num {
    text-align: right;
  }
  /* Sticky at the foot of the grid, the mirror of the headings at its
     top, and on the cells rather than the row: WebKit is reliable about
     `position: sticky` on a table CELL and was never reliable about it
     on `<tfoot>` or `<tr>`, which is the same reason `thead th` carries
     it above. */
  tfoot td {
    position: sticky;
    bottom: 0;
    z-index: 1;
    background: var(--surface-raised);
    border-top: 1px solid var(--border);
    padding-top: 5px;
    padding-bottom: 5px;
  }
  /* Not a flex container: `display: flex` on a `<td>` takes it out of
     the table's cell layout, and an anonymous cell around it would put
     the two figures back out of line with the columns they total. */
  .total {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .total .word {
    color: var(--text);
  }
  .total .cover {
    color: var(--text-subtle);
    margin-left: 8px;
  }
  /* The one place a figure is stated at full strength: the rows are a
     list to scan, this is the answer to what the fleet costs. */
  tfoot .figure {
    color: var(--text);
  }
  .sort {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .sort:hover,
  .sort.active {
    color: var(--text);
  }
  tbody tr {
    /* Shift-click ranges must not double as a text selection. */
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
  tbody td {
    border-top: 1px solid var(--border);
  }
  tbody tr:first-child td {
    border-top: none;
  }
  tr.stale td {
    background: var(--surface-warning);
  }
  tr.survivor td {
    background: var(--surface-danger);
  }
  tbody tr:hover td {
    background: var(--surface-hover);
  }
  /* Selection wins over the stale tints: the mark keeps the colour
     that says stale, and the row has to show it is picked. */
  tr.selected td,
  tr.selected:hover td {
    background: var(--surface-selected);
  }
  .mark {
    color: var(--text-subtle);
    padding-right: 0;
  }
  .mark :global(svg) {
    display: block;
    margin-top: 2px;
  }
  tr.stale .mark {
    color: var(--warning-text);
  }
  tr.survivor .mark {
    color: var(--danger-text);
  }
  .label {
    display: block;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state,
  .where {
    color: var(--text-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .figure {
    text-align: right;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .actions {
    padding-left: 0;
    padding-right: 6px;
  }
  .actions button {
    display: inline-flex;
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
  .note {
    margin: 4px 0 0;
    color: var(--text-muted);
    white-space: normal;
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
  .hints {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* The same voice and place as the card composer's shortcut line. */
  .keys {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.9em;
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
  /* The gap says what the grouping says: everything left of it ends
     sessions in this list, this replaces the process holding them. */
  .apart {
    margin-left: 12px;
  }
</style>
