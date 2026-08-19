<script lang="ts">
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, addCardAction, addColumnAction, updateCardAction, moveCardAction, reorderColumnAction, saveErrors, dismissSaveError } from "./kanbanState";
  import KanbanColumn from "./KanbanColumn.svelte";
  import AutoKanbanColumn from "./AutoKanbanColumn.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import PlanDetailModal from "./PlanDetailModal.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import type { Card } from "./kanban";
  import { gavinTrees } from "./gavinState";
  import { mergePlanCards, type PlanCardView } from "./planBoard";
  import { planCommitFromMerged } from "./planDrop";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import { dragState, buildColumnSlots, type ActiveDrag } from "./kanbanDrag";
  import { flip } from "svelte/animate";
  import type { DropTarget } from "./pointerDrag";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let openCardId = $state<string | null>(null);
  let openPlanPath = $state<string | null>(null);
  let planWriteError = $state<string | null>(null);
  let boardEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void fetchBoard(workspaceId);
  });

  // Staleness (spec §3): the cached board refetches when the hub board
  // remounts and when the window regains focus. refreshBoard's in-flight
  // guard keeps it from clobbering optimistic state.
  $effect(() => {
    void refreshBoard(workspaceId);
    const onFocus = () => void refreshBoard(workspaceId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  const saveError = $derived($saveErrors[workspaceId] ?? null);

  function handleDragCommit(drag: ActiveDrag & { target: DropTarget }): void {
    if (drag.kind === "card") {
      void moveCardAction(workspaceId, drag.id, drag.target.columnId, drag.target.index);
    } else if (drag.kind === "column") {
      void reorderColumnAction(workspaceId, drag.id, drag.target.index);
    } else if (drag.kind === "plan" && board && merged) {
      planWriteError = null;
      void planCommitFromMerged(workspaceId, drag, board.columns, merged).then((err) => {
        if (err) planWriteError = err;
      });
    }
  }

  $effect(() => {
    if (!boardEl) return;
    return attachBoardDrag({
      root: boardEl,
      allowCards: true,
      allowColumns: true,
      commit: handleDragCommit,
      click: (kind, id) => {
        if (kind === "card") openCardId = id;
        else if (kind === "plan") openPlanPath = id;
      },
    });
  });

  const board = $derived($kanbanState[workspaceId]);
  const error = $derived(boardError(workspaceId));
  const openCard = $derived<Card | null>(
    board && openCardId ? (board.columns.flatMap((c) => c.cards).find((c) => c.id === openCardId) ?? null) : null
  );
  const merged = $derived(board ? mergePlanCards(board, $gavinTrees[workspaceId]) : null);
  const openPlan = $derived<PlanCardView | null>(
    merged && openPlanPath
      ? ([...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].find(
          (p) => p.id === openPlanPath
        ) ?? null)
      : null
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
  {#if planWriteError}
    <div class="plan-error">
      <span>{planWriteError}</span>
      <button type="button" onclick={() => (planWriteError = null)}>✕</button>
    </div>
  {/if}
  {#if saveError}
    <div class="plan-error">
      <span>Couldn't save: {saveError}</span>
      <button type="button" onclick={() => dismissSaveError(workspaceId)}>✕</button>
    </div>
  {/if}
  <div class="board" bind:this={boardEl}>
    {#each buildColumnSlots(board.columns, (c) => c.id, $dragState) as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div class="column-slot" animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          {@const column = slot.item}
          <KanbanColumn
            {workspaceId}
            {column}
            otherColumns={board.columns.filter((c) => c.id !== column.id).map((c) => ({ id: c.id, name: c.name }))}
            labels={board.labels}
            planCards={merged?.columns.find((dc) => dc.column.id === column.id)?.planCards ?? []}
            onOpenCard={(cardId) => (openCardId = cardId)}
            onAddCard={() => addCardTo(column.id)}
            onOpenPlanCard={(path) => (openPlanPath = path)}
          />
        {:else}
          <div class="column-placeholder"></div>
        {/if}
      </div>
    {/each}
    {#each merged?.autoColumns ?? [] as auto (auto.status)}
      <AutoKanbanColumn status={auto.status} planCards={auto.planCards} onOpenPlan={(path) => (openPlanPath = path)} />
    {/each}
    <button type="button" class="add-column" onclick={addColumn}>+ Add column</button>
  </div>
  <KanbanDragPreview {board} {merged} labels={board.labels} />
  {#if openCard}
    <CardDetailModal
      card={openCard}
      labels={board.labels}
      {workspaceId}
      onSave={(patch) => void updateCardAction(workspaceId, openCard.id, patch)}
      onClose={() => (openCardId = null)}
    />
  {/if}
  {#if openPlan}
    <PlanDetailModal plan={openPlan} {workspaceId} onClose={() => (openPlanPath = null)} />
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
  /* Wrapper the flip directive needs between the flex strip and the
     column -- must be layout-transparent. */
  .column-slot {
    flex: 0 0 auto;
    display: flex;
    max-height: 100%;
  }
  .column-placeholder {
    width: 240px;
    border: 1px dashed #555;
    border-radius: 8px;
    background: #202020;
    align-self: stretch;
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
  .plan-error {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 16px 0;
    padding: 6px 10px;
    border: 1px solid #a15c2f;
    border-radius: 6px;
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .plan-error button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    margin-left: auto;
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
