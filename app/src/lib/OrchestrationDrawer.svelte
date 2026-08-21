<script lang="ts">
  import { ChevronRight, ChevronLeft, ChevronDown, FileText, ListChecks } from "@lucide/svelte";
  import { orchDragState } from "./orchestrationDrag";
  import type { UnplacedGroup } from "./orchestration";

  interface Props {
    groups: UnplacedGroup[];
    /// Clicking a row adds it to this rail as its own stage; null when
    /// there is no rail to add to yet.
    targetRailId: string | null;
    onAdd: (cardPath: string) => void;
  }
  let { groups, targetRailId, onAdd }: Props = $props();

  let collapsed = $state(false);
  const dragging = $derived($orchDragState !== null);
  const total = $derived(groups.reduce((n, g) => n + g.cards.length, 0));

  // Only DEVIATIONS from the default are stored, so a group the human has
  // not touched follows its own isDone rule even as groups come and go.
  let toggled = $state<Record<string, boolean>>({});
  const isCollapsed = (g: UnplacedGroup): boolean => toggled[g.slug] ?? g.isDone;
</script>

<aside class="drawer" class:collapsed class:drop-lit={dragging} data-orch-drawer>
  <button type="button" class="toggle" onclick={() => (collapsed = !collapsed)}>
    {#if collapsed}<ChevronLeft size={14} />{:else}<ChevronRight size={14} />{/if}
    {#if !collapsed}<span>Unplaced ({total})</span>{/if}
  </button>

  {#if !collapsed}
    {#if dragging}
      <p class="hint">Drop here to take a step off its rail.</p>
    {/if}
    {#each groups as group (group.slug)}
      <button
        type="button"
        class="group-head"
        onclick={() => (toggled = { ...toggled, [group.slug]: !isCollapsed(group) })}
      >
        {#if isCollapsed(group)}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <span class="group-name">{group.status}</span>
        <span class="group-count">{group.cards.length}</span>
      </button>
      {#if !isCollapsed(group)}
        <ul>
          {#each group.cards as entry (entry.plan.path)}
            <li>
              <button type="button" disabled={!targetRailId} onclick={() => onAdd(entry.plan.path)}>
                {#if entry.plan.kind === "plan"}<ListChecks size={12} />{:else}<FileText size={12} />{/if}
                <span>{entry.plan.title}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
    {#if total === 0}
      <p class="empty">Every runnable card is on a rail.</p>
    {/if}
  {/if}
</aside>

<style>
  .drawer {
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
    margin: 0;
    padding: 8px 6px;
    color: var(--text-subtle);
    font-size: 11px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 4px 6px;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .group-head:hover {
    background: var(--surface-hover);
  }
  .group-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-count {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
  }
</style>
