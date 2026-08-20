<script lang="ts">
  import type { Column, Label } from "./kanban";
  import type { CardView } from "./planBoard";
  import BoardCard from "./BoardCard.svelte";
  import { dragState, dropHold, buildDisplaySlots } from "./kanbanDrag";
  import { flip } from "svelte/animate";
  import { renameColumnAction, deleteColumnAction } from "./kanbanState";

  interface Props {
    workspaceId: string;
    column: Column;
    // "full" is the hub board; "planOnly" is the per-context BoardPane
    // (spec §4): read-only header, no column dragging -- one component,
    // both surfaces.
    mode?: "full" | "planOnly";
    labels?: Label[];
    planCards: CardView[];
    onOpenPlanCard: (path: string) => void;
  }
  let { workspaceId, column, mode = "full", labels = [], planCards, onOpenPlanCard }: Props = $props();

  let editingName = $state(false);
  // Filled by startRename when editing begins -- initializing from
  // column.name here would freeze the first render's value.
  let nameDraft = $state("");

  function startRename(): void {
    nameDraft = column.name;
    editingName = true;
  }

  function commitRename(): void {
    editingName = false;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== column.name) void renameColumnAction(workspaceId, column.id, trimmed);
  }

  // All cards are file-backed (card-model spec §1): one block per
  // column, rendered through display slots -- while a matching drag is
  // live (or a drop's writes are in flight), the dragged card is hidden
  // and a placeholder occupies the target slot; animate:flip slides the
  // rest.
  const slotDrag = $derived($dragState ?? $dropHold);
  const planSlots = $derived(buildDisplaySlots(planCards, (p) => p.id, slotDrag, column.id, "plan"));

  // Deleting a column never touches card files -- cards whose status
  // matched it fall back to an auto column (D6), so no prompt is needed.
  function deleteColumn(): void {
    void deleteColumnAction(workspaceId, column.id);
  }
</script>

<div class="column" class:plan-only={mode === "planOnly"} data-kb-col={column.id}>
  <div class="header" data-kb-colgrab={mode === "full" ? column.id : undefined}>
    {#if mode === "planOnly"}
      <span class="name readonly">{column.name}</span>
      <span class="count">{planCards.length}</span>
    {:else if editingName}
      <input
        type="text"
        bind:value={nameDraft}
        onblur={commitRename}
        onkeydown={(e) => e.key === "Enter" && commitRename()}
      />
    {:else}
      <button type="button" class="name" onclick={startRename} title="Rename column">{column.name}</button>
      <span class="count">{planCards.length}</span>
    {/if}
    {#if mode === "full"}
      <button type="button" class="delete" aria-label="Delete column" onclick={deleteColumn}>×</button>
    {/if}
  </div>
  <div class="cards" data-kb-cards>
    {#each planSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id}>
            <BoardCard card={slot.item} labelDefs={labels} onOpen={onOpenPlanCard} />
          </div>
        {:else}
          <div class="slot-placeholder" data-kb-ph style:height="{slotDrag?.size?.height ?? 40}px"></div>
        {/if}
      </div>
    {/each}
  </div>
</div>

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
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .column.plan-only .header {
    cursor: default;
  }
  .header .name.readonly {
    cursor: default;
  }
  .count {
    color: #888;
    font-weight: normal;
    font-size: 0.85em;
    margin-left: 6px;
    margin-right: auto;
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
</style>
