<script lang="ts">
  import { kanbanState, fetchBoard, boardError, retryFetchBoard, addCardAction, addColumnAction, updateCardAction, moveCardAction } from "./kanbanState";
  import KanbanColumn from "./KanbanColumn.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";
  import PlanDetailModal from "./PlanDetailModal.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import type { Card } from "./kanban";
  import { gavinTrees, patchPlanField } from "./gavinState";
  import { mergePlanCards, type PlanCardView } from "./planBoard";
  import { getDragKind, getDragPayload } from "./dragDrop";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import type { ActiveDrag } from "./kanbanDrag";
  import type { DropTarget } from "./pointerDrag";
  import * as backend from "./backend";

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

  function handleDragCommit(drag: ActiveDrag & { target: DropTarget }): void {
    if (drag.kind === "card") {
      void moveCardAction(workspaceId, drag.id, drag.target.columnId, drag.target.index);
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

  // Drop-driven restatus: write first, patch on success only (spec §2) --
  // a failed write leaves the card where it was and names the file.
  async function setPlanStatus(path: string, columnName: string): Promise<void> {
    planWriteError = null;
    const fileName = path.split("/").at(-1) ?? path;
    try {
      await backend.setPlanFrontmatterField(path, "status", columnName);
      patchPlanField(workspaceId, path, "status", columnName);
    } catch (e) {
      planWriteError = `Couldn't update ${fileName}: ${e}`;
    }
  }

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
  <div class="board" bind:this={boardEl}>
    {#each board.columns as column, columnIndex (column.id)}
      <KanbanColumn
        {workspaceId}
        {column}
        otherColumns={board.columns.filter((c) => c.id !== column.id).map((c) => ({ id: c.id, name: c.name }))}
        labels={board.labels}
        planCards={merged?.columns[columnIndex]?.planCards ?? []}
        onOpenCard={(cardId) => (openCardId = cardId)}
        onAddCard={() => addCardTo(column.id)}
        onOpenPlanCard={(path) => (openPlanPath = path)}
        onPlanDrop={(path) => void setPlanStatus(path, column.name)}
      />
    {/each}
    {#each merged?.autoColumns ?? [] as auto (auto.status)}
      <div
        class="auto-column"
        role="list"
        ondragover={(e) => {
          if (getDragKind(e) === "plan-card") e.preventDefault();
        }}
        ondrop={(e) => {
          e.preventDefault();
          const payload = getDragPayload(e);
          if (payload?.kind === "plan-card") void setPlanStatus(payload.path, auto.status);
        }}
      >
        <div class="auto-header" title="Status not matching any column">{auto.status}</div>
        {#each auto.planCards as plan (plan.id)}
          <PlanKanbanCard {plan} onOpen={() => (openPlanPath = plan.id)} />
        {/each}
      </div>
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
  /* Same geometry as KanbanColumn's .column, muted + dashed: these exist
     only so no plan with an unmatched status can ever be invisible. */
  .auto-column {
    background: #232323;
    border: 1px dashed #555;
    border-radius: 8px;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    max-height: 100%;
    overflow-y: auto;
    font-family: monospace;
    box-sizing: border-box;
  }
  .auto-header {
    color: #bbb;
    font-size: 0.85em;
    margin-bottom: 8px;
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
