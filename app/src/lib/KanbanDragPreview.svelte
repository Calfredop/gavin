<script lang="ts">
  import { dragState } from "./kanbanDrag";
  import type { Board, Card, Label } from "./kanban";
  import type { PlanCardView } from "./planBoard";
  import KanbanCard from "./KanbanCard.svelte";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";

  interface Props {
    board: Board | null;
    merged: { columns: { column: { id: string; name: string }; planCards: PlanCardView[] }[]; autoColumns: { status: string; planCards: PlanCardView[] }[] } | null;
    labels: Label[];
  }
  let { board, merged, labels }: Props = $props();

  const draggedCard = $derived<Card | null>(
    $dragState?.kind === "card" && board
      ? (board.columns.flatMap((c) => c.cards).find((c) => c.id === $dragState?.id) ?? null)
      : null
  );
  const draggedPlan = $derived<PlanCardView | null>(
    $dragState?.kind === "plan" && merged
      ? ([...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].find(
          (p) => p.id === $dragState?.id
        ) ?? null)
      : null
  );
  const draggedColumn = $derived(
    $dragState?.kind === "column" && board ? (board.columns.find((c) => c.id === $dragState?.id) ?? null) : null
  );

  function noop(): void {}
</script>

{#if $dragState}
  <div
    class="preview"
    style:left="{$dragState.pointer.x - $dragState.grabOffset.x}px"
    style:top="{$dragState.pointer.y - $dragState.grabOffset.y}px"
    style:width="{$dragState.size.width}px"
  >
    {#if draggedCard}
      <KanbanCard card={draggedCard} columnId="" {labels} onOpen={noop} onDelete={noop} />
    {:else if draggedPlan}
      <PlanKanbanCard plan={draggedPlan} onOpen={noop} />
    {:else if draggedColumn}
      <div class="column-shell">
        <div class="column-title">{draggedColumn.name}</div>
        <div class="column-count">{draggedColumn.cards.length} cards</div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .preview {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    transform: rotate(3deg);
    filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.5));
  }
  .column-shell {
    background: #232323;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 10px;
    color: #eee;
    font-family: monospace;
  }
  .column-title {
    font-weight: bold;
    margin-bottom: 4px;
  }
  .column-count {
    color: #999;
    font-size: 0.85em;
  }
</style>
