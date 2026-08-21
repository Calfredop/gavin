<script lang="ts">
  import { ChevronRight, ChevronLeft, FileText, ListChecks } from "@lucide/svelte";
  import { orchDragState } from "./orchestrationDrag";
  import type { CardEntry } from "./orchestration";

  interface Props {
    available: CardEntry[];
    /// Clicking a row adds it to this rail as its own stage; null when
    /// there is no rail to add to yet.
    targetRailId: string | null;
    onAdd: (cardPath: string) => void;
  }
  let { available, targetRailId, onAdd }: Props = $props();

  let collapsed = $state(false);
  const dragging = $derived($orchDragState !== null);
</script>

<aside class="drawer" class:collapsed class:drop-lit={dragging} data-orch-drawer>
  <button type="button" class="toggle" onclick={() => (collapsed = !collapsed)}>
    {#if collapsed}<ChevronLeft size={14} />{:else}<ChevronRight size={14} />{/if}
    {#if !collapsed}<span>Unplaced ({available.length})</span>{/if}
  </button>

  {#if !collapsed}
    {#if dragging}
      <p class="hint">Drop here to take a step off its rail.</p>
    {/if}
    <ul>
      {#each available as entry (entry.plan.path)}
        <li>
          <button type="button" disabled={!targetRailId} onclick={() => onAdd(entry.plan.path)}>
            {#if entry.plan.kind === "plan"}<ListChecks size={12} />{:else}<FileText size={12} />{/if}
            <span>{entry.plan.title}</span>
          </button>
        </li>
      {/each}
      {#if available.length === 0}
        <li class="empty">Every runnable card is on a rail.</li>
      {/if}
    </ul>
  {/if}
</aside>

<style>
  .drawer {
    font-family: monospace;
    flex: none;
    width: 220px;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface-sunken);
    overflow-y: auto;
  }
  .drawer.collapsed {
    width: 32px;
  }
  .drawer.drop-lit {
    outline: 2px dashed var(--border-focus);
    outline-offset: -2px;
  }
  .toggle {
    font-family: monospace;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .hint {
    margin: 0;
    padding: 8px;
    color: var(--accent-text);
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
  }
  li button {
    font-family: monospace;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  li button:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  li button:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  li button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    padding: 8px 6px;
    color: var(--text-subtle);
    font-size: 11px;
  }
</style>
