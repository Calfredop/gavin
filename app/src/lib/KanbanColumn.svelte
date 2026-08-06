<script lang="ts">
  import type { Column, Label } from "./kanban";
  import type { PlanCardView } from "./planBoard";
  import KanbanCard from "./KanbanCard.svelte";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";
  import DeleteColumnPrompt from "./DeleteColumnPrompt.svelte";
  import DeleteCardWithSessionPrompt from "./DeleteCardWithSessionPrompt.svelte";
  import { setDragPayload, getDragKind, getDragPayload, computeReorderPosition } from "./dragDrop";
  import {
    moveCardAction,
    reorderColumnAction,
    renameColumnAction,
    deleteColumnCascadeAction,
    moveCardsOutOfColumnAndDeleteAction,
    deleteCardAction,
  } from "./kanbanState";
  import { layoutState, closeSession } from "./layoutState";
  import { findSessionLocation } from "./workspace";

  interface Props {
    workspaceId: string;
    column: Column;
    otherColumns: { id: string; name: string }[];
    labels: Label[];
    planCards: PlanCardView[];
    onOpenCard: (cardId: string) => void;
    onAddCard: () => void;
    onOpenPlanCard: (path: string) => void;
    onPlanDrop: (path: string) => void;
  }
  let { workspaceId, column, otherColumns, labels, planCards, onOpenCard, onAddCard, onOpenPlanCard, onPlanDrop }: Props =
    $props();

  let editingName = $state(false);
  let nameDraft = $state(column.name);
  let showDeletePrompt = $state(false);
  let pendingDeleteCardId = $state<string | null>(null);

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
    if (kind !== "kanban-card" && kind !== "plan-card") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function handleCardDrop(event: DragEvent, dropIndex: number): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (!payload) return;
    if (payload.kind === "plan-card") {
      // Drop position is ignored: plan ordering is deterministic (spec §1).
      onPlanDrop(payload.path);
      return;
    }
    if (payload.kind !== "kanban-card") return;
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

  function requestDeleteCard(cardId: string): void {
    const target = column.cards.find((c) => c.id === cardId);
    const location = target?.sessionLink ? findSessionLocation($layoutState, target.sessionLink.sessionId) : null;
    if (location) {
      pendingDeleteCardId = cardId;
    } else {
      void deleteCardAction(workspaceId, cardId);
    }
  }

  async function confirmDeleteCard(): Promise<void> {
    const cardId = pendingDeleteCardId;
    pendingDeleteCardId = null;
    if (!cardId) return;
    const target = column.cards.find((c) => c.id === cardId);
    if (target?.sessionLink) await closeSession(target.sessionLink.sessionId);
    await deleteCardAction(workspaceId, cardId);
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
        <KanbanCard
          {card}
          columnId={column.id}
          {labels}
          onOpen={() => onOpenCard(card.id)}
          onDelete={() => requestDeleteCard(card.id)}
        />
      </div>
    {/each}
    {#each planCards as plan (plan.id)}
      <PlanKanbanCard {plan} onOpen={() => onOpenPlanCard(plan.id)} />
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

{#if pendingDeleteCardId}
  <DeleteCardWithSessionPrompt onConfirm={confirmDeleteCard} onCancel={() => (pendingDeleteCardId = null)} />
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
