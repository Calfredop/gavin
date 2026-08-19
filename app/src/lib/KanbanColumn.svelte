<script lang="ts">
  import type { Column, Label } from "./kanban";
  import type { PlanCardView } from "./planBoard";
  import KanbanCard from "./KanbanCard.svelte";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";
  import DeleteColumnPrompt from "./DeleteColumnPrompt.svelte";
  import DeleteCardWithSessionPrompt from "./DeleteCardWithSessionPrompt.svelte";
  import { dragState, buildDisplaySlots } from "./kanbanDrag";
  import { flip } from "svelte/animate";
  import {
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
    // "full" is the hub board; "planOnly" is the per-context BoardPane
    // (spec §4): plan cards only, read-only header, no composer, no
    // column dragging -- one component, both surfaces.
    mode?: "full" | "planOnly";
    otherColumns?: { id: string; name: string }[];
    labels?: Label[];
    planCards: PlanCardView[];
    onOpenCard?: (cardId: string) => void;
    onAddCard?: () => void;
    onOpenPlanCard: (path: string) => void;
  }
  let {
    workspaceId,
    column,
    mode = "full",
    otherColumns = [],
    labels = [],
    planCards,
    onOpenCard = () => {},
    onAddCard = () => {},
    onOpenPlanCard,
  }: Props = $props();

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

  // Cards render through display slots: while a matching drag is live,
  // the dragged item is hidden and a placeholder occupies the current
  // target slot; animate:flip slides the rest (spec §1). Free-form and
  // plan blocks slot independently -- a card never targets the plan
  // block and vice versa (spec §2, K4).
  const cardSlots = $derived(buildDisplaySlots(column.cards, (c) => c.id, $dragState, column.id, "card"));
  const planSlots = $derived(buildDisplaySlots(planCards, (p) => p.id, $dragState, column.id, "plan"));

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

<div class="column" class:plan-only={mode === "planOnly"} data-kb-col={column.id}>
  <div class="header" data-kb-colgrab={mode === "full" ? column.id : undefined}>
    {#if mode === "planOnly"}
      <span class="name readonly">{column.name}</span>
    {:else if editingName}
      <input
        type="text"
        bind:value={nameDraft}
        onblur={commitRename}
        onkeydown={(e) => e.key === "Enter" && commitRename()}
      />
    {:else}
      <span class="name" onclick={startRename} role="button" tabindex="0">{column.name}</span>
    {/if}
    {#if mode === "full"}
      <button type="button" class="delete" aria-label="Delete column" onclick={requestDeleteColumn}>×</button>
    {/if}
  </div>
  <div class="cards" data-kb-cards>
    {#if mode === "full"}
      {#each cardSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
        <div animate:flip={{ duration: 150 }}>
          {#if slot.type === "item"}
            <div data-kb-card={slot.item.id}>
              <KanbanCard
                card={slot.item}
                columnId={column.id}
                {labels}
                onOpen={() => onOpenCard(slot.item.id)}
                onDelete={() => requestDeleteCard(slot.item.id)}
              />
            </div>
          {:else}
            <div class="slot-placeholder" style:height="{$dragState?.size.height ?? 40}px"></div>
          {/if}
        </div>
      {/each}
    {/if}
    {#each planSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id}>
            <PlanKanbanCard plan={slot.item} onOpen={() => onOpenPlanCard(slot.item.id)} />
          </div>
        {:else}
          <div class="slot-placeholder" style:height="{$dragState?.size.height ?? 40}px"></div>
        {/if}
      </div>
    {/each}
  </div>
  {#if mode === "full"}
    <button type="button" class="add-card" onclick={onAddCard}>+ Add card</button>
  {/if}
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
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  .slot-placeholder {
    border: 1px dashed #555;
    border-radius: 6px;
    background: #202020;
    margin-bottom: 6px;
    box-sizing: border-box;
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
  .column.plan-only .header {
    cursor: default;
  }
  .header .name.readonly {
    cursor: default;
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
