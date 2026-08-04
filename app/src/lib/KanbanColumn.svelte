<script lang="ts">
  import type { Column, Label } from "./kanban";
  import KanbanCard from "./KanbanCard.svelte";
  import DeleteColumnPrompt from "./DeleteColumnPrompt.svelte";
  import { setDragPayload, getDragKind, getDragPayload, computeReorderPosition } from "./dragDrop";
  import {
    moveCardAction,
    reorderColumnAction,
    renameColumnAction,
    deleteColumnCascadeAction,
    moveCardsOutOfColumnAndDeleteAction,
  } from "./kanbanState";

  interface Props {
    workspaceId: string;
    column: Column;
    otherColumns: { id: string; name: string }[];
    labels: Label[];
    onOpenCard: (cardId: string) => void;
    onAddCard: () => void;
  }
  let { workspaceId, column, otherColumns, labels, onOpenCard, onAddCard }: Props = $props();

  let editingName = $state(false);
  let nameDraft = $state(column.name);
  let showDeletePrompt = $state(false);

  function startRename(): void {
    nameDraft = column.name;
    editingName = true;
  }

  function commitRename(): void {
    editingName = false;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== column.name) void renameColumnAction(workspaceId, column.id, trimmed);
  }

  function handleColumnDragStart(event: DragEvent): void {
    setDragPayload(event, { kind: "kanban-column", columnId: column.id });
  }

  function handleColumnDragOver(event: DragEvent): void {
    const kind = getDragKind(event);
    if (kind !== "kanban-column") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function handleColumnDrop(event: DragEvent): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (!payload || payload.kind !== "kanban-column" || payload.columnId === column.id) return;
    void reorderColumnAction(workspaceId, payload.columnId, column.position);
  }

  function handleCardDragOver(event: DragEvent): void {
    const kind = getDragKind(event);
    if (kind !== "kanban-card") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function handleCardDrop(event: DragEvent, dropIndex: number): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (!payload || payload.kind !== "kanban-card") return;
    void moveCardAction(workspaceId, payload.cardId, column.id, dropIndex);
  }

  function handleCardSlotDragOver(event: DragEvent): "before" | "after" | null {
    const kind = getDragKind(event);
    if (kind !== "kanban-card") return null;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return computeReorderPosition(rect, event.clientY);
  }

  function requestDeleteColumn(): void {
    if (column.cards.length === 0) {
      void deleteColumnCascadeAction(workspaceId, column.id);
    } else {
      showDeletePrompt = true;
    }
  }
</script>

<div
  class="column"
  draggable="true"
  ondragstart={handleColumnDragStart}
  ondragover={handleColumnDragOver}
  ondrop={handleColumnDrop}
>
  <div class="header">
    {#if editingName}
      <input
        type="text"
        bind:value={nameDraft}
        onblur={commitRename}
        onkeydown={(e) => e.key === "Enter" && commitRename()}
      />
    {:else}
      <span class="name" onclick={startRename} role="button" tabindex="0">{column.name}</span>
    {/if}
    <button type="button" class="delete" aria-label="Delete column" onclick={requestDeleteColumn}>×</button>
  </div>
  <div class="cards" ondragover={handleCardDragOver} ondrop={(e) => handleCardDrop(e, column.cards.length)}>
    {#each column.cards as card, index (card.id)}
      <div
        ondragover={(e) => {
          handleCardDragOver(e);
          e.stopPropagation();
        }}
        ondrop={(e) => {
          const position = handleCardSlotDragOver(e);
          handleCardDrop(e, position === "before" ? index : index + 1);
          e.stopPropagation();
        }}
      >
        <KanbanCard {card} columnId={column.id} {labels} onOpen={() => onOpenCard(card.id)} />
      </div>
    {/each}
  </div>
  <button type="button" class="add-card" onclick={onAddCard}>+ Add card</button>
</div>

{#if showDeletePrompt}
  <DeleteColumnPrompt
    columnName={column.name}
    cardCount={column.cards.length}
    {otherColumns}
    onDeleteCards={() => {
      showDeletePrompt = false;
      void deleteColumnCascadeAction(workspaceId, column.id);
    }}
    onMoveCards={(targetColumnId) => {
      showDeletePrompt = false;
      void moveCardsOutOfColumnAndDeleteAction(workspaceId, column.id, targetColumnId);
    }}
    onCancel={() => (showDeletePrompt = false)}
  />
{/if}

<style>
  .column {
    background: #232323;
    border-radius: 8px;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    max-height: 100%;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    color: #eee;
    font-family: monospace;
    font-weight: bold;
  }
  .header input {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 2px 4px;
    border-radius: 4px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .header .name {
    cursor: text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delete {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    font-size: 1.1em;
  }
  .cards {
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .add-card {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    font-family: monospace;
    text-align: left;
    padding: 4px 0;
  }
</style>
