<script lang="ts">
  import type { Card, Label } from "./kanban";
  import { setDragPayload } from "./dragDrop";

  interface Props {
    card: Card;
    columnId: string;
    labels: Label[];
    onOpen: () => void;
  }
  let { card, columnId, labels, onOpen }: Props = $props();

  const cardLabels = $derived(labels.filter((l) => card.labelIds.includes(l.id)));

  function handleDragStart(event: DragEvent): void {
    setDragPayload(event, { kind: "kanban-card", cardId: card.id, sourceColumnId: columnId });
  }
</script>

<div class="card" draggable="true" ondragstart={handleDragStart} onclick={onOpen} role="button" tabindex="0">
  {#if card.priority !== "none"}
    <span class="priority priority-{card.priority}" title="Priority: {card.priority}"></span>
  {/if}
  <div class="title">{card.title}</div>
  {#if cardLabels.length > 0}
    <div class="labels">
      {#each cardLabels as label (label.id)}
        <span class="label-chip" style:border-color={label.color}>{label.name}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .card {
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    color: #eee;
    font-family: monospace;
    font-size: 0.85em;
  }
  .priority {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-bottom: 4px;
  }
  .priority-low {
    background: #6b8e6b;
  }
  .priority-medium {
    background: #d9a648;
  }
  .priority-high {
    background: #d97748;
  }
  .priority-urgent {
    background: #d94848;
  }
  .title {
    word-break: break-word;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .label-chip {
    border: 1px solid #666;
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.85em;
  }
</style>
