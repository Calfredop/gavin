<script lang="ts">
  // One Scheduled task's row: its title and state, the schedule in words,
  // when it runs next and ran last, and what its last run reported. The
  // desk's Scheduled tab draws it, and so does the Companion's Scheduled
  // surface, so a task reads the same in both places. The row is
  // scheduledView.ts's; this only lays it out.
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { scheduledLookIndicator } from "$lib/ui/indicators";
  import { STATE_LABEL, type ScheduledRow } from "$lib/scheduling/scheduledView";

  interface Props {
    row: ScheduledRow;
    selected: boolean;
    onPick: () => void;
    /// The phone's taller rows and larger type.
    roomy?: boolean;
  }
  let { row, selected, onPick, roomy = false }: Props = $props();
</script>

<button
  type="button"
  role="option"
  aria-selected={selected}
  class="row"
  class:selected
  class:roomy
  onclick={onPick}
>
  <span class="title">
    {#if row.needsLook}<StatusBadge indicator={scheduledLookIndicator()} />{/if}
    {row.title}
  </span>
  <span class="state state-{row.state}">{STATE_LABEL[row.state]}</span>
  <span class="detail">{row.schedule}</span>
  <span class="detail">
    Next {row.nextRun ?? "—"} · Last {row.lastRun ?? "never"} · {row.totalRuns} runs
  </span>
  {#if row.lastResult}<span class="result">{row.lastResult}</span>{/if}
</button>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 8px;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .row.roomy {
    padding: 12px 16px;
    gap: 4px 10px;
  }
  .row.selected {
    background: var(--surface-hover);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    font-size: 0.88em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .roomy .title {
    font-size: 1em;
  }
  .state {
    font-size: 0.72em;
    color: var(--text-muted);
  }
  .state-running {
    color: var(--success-text);
  }
  .state-broken {
    color: var(--danger-text);
  }
  .detail,
  .result {
    grid-column: 1 / -1;
    font-size: 0.75em;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .roomy .detail,
  .roomy .result {
    font-size: 0.85em;
    white-space: normal;
  }
  .result {
    color: var(--text);
  }
</style>
