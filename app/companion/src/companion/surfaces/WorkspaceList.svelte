<script lang="ts">
  // The workspace list. A thin template over workspaceList.ts, which is
  // where every word and number on a row is decided.
  import { kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { attentionStatusById, layoutState } from "$lib/core/layoutState";
  import { FolderPlus } from "@lucide/svelte";
  import { agentIndicatorByState } from "$lib/ui/indicators";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { workspaceRows } from "$companion/surfaces/workspaceList";

  interface Props {
    onOpen: (workspaceId: string) => void;
    /// Starts adding a workspace from a folder on the Workstation.
    onAdd: () => void;
  }
  let { onOpen, onAdd }: Props = $props();

  // Derived here, in the component, and not as a store beside the
  // module: a module-level derived over a layoutState export is built at
  // import, which breaks every suite that mocks that module in part.
  const rows = $derived(
    workspaceRows({
      workspaces: $layoutState.workspaces,
      boards: $kanbanState,
      trees: $gavinTrees,
      tabs: {
        sessionStatusById: $attentionStatusById,
        fileTabsById: $layoutState.fileTabsById,
        boardTabsById: $layoutState.boardTabsById,
        cardTabsById: $layoutState.cardTabsById,
      },
    })
  );

  const waiting = agentIndicatorByState("waiting_for_input");
  const failed = agentIndicatorByState("failed");
</script>

{#if rows.length === 0}
  <p class="empty">This Workstation has no workspaces yet.</p>
{:else}
  <ul class="list">
    {#each rows as row (row.id)}
      <li>
        <button type="button" class="row" style:--accent-spine={row.color} onclick={() => onOpen(row.id)}>
          <span class="head">
            <span class="name">{row.name}</span>
            {#if row.failed > 0}
              <StatusBadge indicator={failed} size={14} text={row.failed} tip={null} />
            {/if}
            {#if row.waiting > 0}
              <StatusBadge indicator={waiting} size={14} text={row.waiting} tip={null} />
            {/if}
          </span>
          {#if row.folder}
            <!-- The folder's END is the part that tells two checkouts
                 apart, so that is the end that stays when it is cut. -->
            <span class="folder"><bdi>{row.folder}</bdi></span>
          {:else}
            <span class="folder none">no folder</span>
          {/if}
          <span class="agents">{row.agents}</span>
          {#if row.columns.length > 0}
            <span class="columns">
              {#each row.columns as column (column.name)}
                <span class="column tone-{column.tone}" class:quiet={column.count === 0}>
                  <span class="column-name">{column.name}</span>
                  <span class="column-count">{column.count}</span>
                </span>
              {/each}
            </span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}
<button type="button" class="add" onclick={onAdd}>
  <FolderPlus size={18} />
  <span>Add a workspace…</span>
</button>

<style>
  .add {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 52px;
    padding: 0 max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    color: var(--accent-text);
    font-size: 0.9375rem;
    text-align: left;
  }
  .add:active {
    background: var(--surface-hover);
  }
  .add:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .empty {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 14px max(14px, env(safe-area-inset-right)) 14px max(14px, env(safe-area-inset-left));
    border: 0;
    border-bottom: 1px solid var(--border);
    /* The workspace's own accent, as the spine the desk's sidebar gives
       the same row. */
    box-shadow: inset 4px 0 0 var(--accent-spine);
    background: none;
    color: var(--text);
    text-align: left;
  }
  .row:active {
    background: var(--surface-hover);
  }
  .row:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    font-size: 1.0625rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder {
    overflow: hidden;
    color: var(--text-subtle);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .folder.none {
    direction: ltr;
    font-style: italic;
  }
  .agents {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .columns {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  .column {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 8px;
    border: 1px solid var(--chip-border, var(--border));
    border-radius: 999px;
    color: var(--chip-text, var(--text-muted));
    font-size: 0.75rem;
  }
  .column-count {
    color: var(--text);
    font-weight: 600;
  }
  .column.tone-progress {
    --chip-border: var(--border-accent);
    --chip-text: var(--accent-text);
  }
  .column.tone-done {
    --chip-border: var(--border-success);
    --chip-text: var(--success-text);
  }
  /* An empty column keeps its place and gives up its colour: the board's
     shape must not change with how full it happens to be. */
  .column.quiet {
    --chip-border: var(--border);
    --chip-text: var(--text-subtle);
  }
  .column.quiet .column-count {
    color: var(--text-subtle);
    font-weight: 400;
  }
</style>
