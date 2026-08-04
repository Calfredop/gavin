<script lang="ts">
  import { kanbanState, fetchBoard, boardError, retryFetchBoard, addCardAction, addColumnAction, updateCardAction } from "./kanbanState";
  import KanbanColumn from "./KanbanColumn.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import type { Card } from "./kanban";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let openCardId = $state<string | null>(null);

  $effect(() => {
    void fetchBoard(workspaceId);
  });

  const board = $derived($kanbanState[workspaceId]);
  const error = $derived(boardError(workspaceId));
  const openCard = $derived<Card | null>(
    board && openCardId ? (board.columns.flatMap((c) => c.cards).find((c) => c.id === openCardId) ?? null) : null
  );

  function addColumn(): void {
    const name = "New column";
    void addColumnAction(workspaceId, {
      id: crypto.randomUUID(),
      name,
      position: board?.columns.length ?? 0,
      cards: [],
    });
  }

  function addCardTo(columnId: string): void {
    void addCardAction(workspaceId, columnId, {
      id: crypto.randomUUID(),
      title: "New card",
      description: "",
      labelIds: [],
      priority: "none",
      position: board?.columns.find((c) => c.id === columnId)?.cards.length ?? 0,
    });
  }
</script>

{#if error}
  <div class="overlay">
    <p>Couldn't load this board.</p>
    <p class="detail">{error}</p>
    <button onclick={() => retryFetchBoard(workspaceId)}>Retry</button>
  </div>
{:else if !board}
  <div class="overlay">
    <p>Loading board…</p>
  </div>
{:else}
  <div class="board">
    {#each board.columns as column (column.id)}
      <KanbanColumn
        {workspaceId}
        {column}
        otherColumns={board.columns.filter((c) => c.id !== column.id).map((c) => ({ id: c.id, name: c.name }))}
        labels={board.labels}
        onOpenCard={(cardId) => (openCardId = cardId)}
        onAddCard={() => addCardTo(column.id)}
      />
    {/each}
    <button type="button" class="add-column" onclick={addColumn}>+ Add column</button>
  </div>
  {#if openCard}
    <CardDetailModal
      card={openCard}
      labels={board.labels}
      {workspaceId}
      onSave={(patch) => void updateCardAction(workspaceId, openCard.id, patch)}
      onClose={() => (openCardId = null)}
    />
  {/if}
{/if}

<style>
  .board {
    display: flex;
    gap: 12px;
    padding: 16px;
    overflow-x: auto;
    height: 100%;
    box-sizing: border-box;
  }
  .add-column {
    background: transparent;
    border: 1px dashed #444;
    border-radius: 8px;
    color: #999;
    cursor: pointer;
    font-family: monospace;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    align-self: flex-start;
  }
  .overlay {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #eee;
    font-family: monospace;
    height: 100%;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .overlay button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #3a3a3a;
    border: none;
    color: #eee;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
