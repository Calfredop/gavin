<script lang="ts">
  import type { Card, Label } from "./kanban";
  import { setDragPayload } from "./dragDrop";
  import { layoutState } from "./layoutState";
  import { findSessionLocation } from "./workspace";

  interface Props {
    card: Card;
    columnId: string;
    labels: Label[];
    onOpen: () => void;
    onDelete: () => void;
  }
  let { card, columnId, labels, onOpen, onDelete }: Props = $props();

  const cardLabels = $derived(labels.filter((l) => card.labelIds.includes(l.id)));

  function handleDragStart(event: DragEvent): void {
    setDragPayload(event, { kind: "kanban-card", cardId: card.id, sourceColumnId: columnId });
  }

  function handleDelete(event: MouseEvent): void {
    event.stopPropagation();
    onDelete();
  }

  // Reuses Pane.svelte's status-dot styling/meaning for working/waiting,
  // but unlike a tab (where "no dot" already means idle), a linked card
  // always shows *something* -- idle gets its own dot, and a session no
  // longer present in any page (exited, or never found) reads as a
  // distinct, dimmer state, since a card can stay linked to a long-gone
  // session indefinitely.
  function sessionDot(): { class: string; title: string } | null {
    if (!card.sessionLink) return null;
    const location = findSessionLocation($layoutState, card.sessionLink.sessionId);
    const status = location ? $layoutState.sessionStatusById[card.sessionLink.sessionId] : undefined;
    if (status === "working") return { class: "status-working", title: "Working" };
    if (status === "waiting_for_input") return { class: "status-waiting", title: "Request attention" };
    if (status === "idle") return { class: "status-idle", title: "Idle" };
    return { class: "status-exited", title: "Session exited" };
  }
</script>

<div class="card" draggable="true" ondragstart={handleDragStart} onclick={onOpen} role="button" tabindex="0">
  <div class="header">
    {#if card.priority !== "none"}
      <span class="priority priority-{card.priority}" title="Priority: {card.priority}"></span>
    {/if}
    {#if sessionDot()}
      {@const dot = sessionDot()}
      <span class="status-dot {dot?.class}" title={dot?.title}></span>
    {/if}
    <button type="button" class="delete" aria-label="Delete card" onclick={handleDelete}>×</button>
  </div>
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
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .priority {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
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
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .status-dot.status-working {
    background: #4a9eff;
  }
  .status-dot.status-waiting {
    background: #e0524a;
  }
  .status-dot.status-idle {
    background: #6b8e6b;
  }
  .status-dot.status-exited {
    background: transparent;
    border: 1px solid #666;
  }
  .delete {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    font-size: 1.1em;
    margin-left: auto;
    padding: 0;
    line-height: 1;
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
