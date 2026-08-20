<script lang="ts">
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, addColumnAction, reorderColumnAction, saveErrors, dismissSaveError } from "./kanbanState";
  import KanbanColumn from "./KanbanColumn.svelte";
  import AutoKanbanColumn from "./AutoKanbanColumn.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import { gavinTrees } from "./gavinState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import { planCommitFromMerged } from "./planDrop";
  import { runCard } from "./cardRunActions";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import { dragState, buildColumnSlots, type ActiveDrag } from "./kanbanDrag";
  import { flip } from "svelte/animate";
  import { tooltip } from "./tooltip";
  import type { DropTarget } from "./pointerDrag";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

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

  const board = $derived($kanbanState[workspaceId]);
  const error = $derived(boardError(workspaceId));
  const merged = $derived(board ? mergePlanCards(board, $gavinTrees[workspaceId]) : null);
  // Every card view in the projection, nested children included -- the
  // detail modal must resolve a nested child's path too.
  const allCards = $derived<CardView[]>(
    merged
      ? [...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].flatMap(
          (c) => [c, ...c.nestedChildren]
        )
      : []
  );
  const openPlan = $derived<CardView | null>(
    openPlanPath ? (allCards.find((p) => p.id === openPlanPath) ?? null) : null
  );

  async function handleRun(card: CardView): Promise<void> {
    planWriteError = null;
    const err = await runCard(workspaceId, card);
    if (err) planWriteError = err;
  }

  function handleDragCommit(drag: ActiveDrag & { target: DropTarget }): void {
    if (drag.kind === "column") {
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
      allowColumns: true,
      commit: handleDragCommit,
      click: (kind, id) => {
        if (kind === "plan") openPlanPath = id;
      },
    });
  });

  // Inline column composer (spec §6): Enter commits and keeps the field
  // open, blur with text commits and closes, Esc or empty blur closes.
  let addingColumn = $state(false);
  let columnDraft = $state("");
  let columnInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (addingColumn && columnInputEl) columnInputEl.focus();
  });

  function commitColumnComposer(keepOpen: boolean): void {
    const name = columnDraft.trim();
    columnDraft = "";
    if (name) {
      void addColumnAction(workspaceId, {
        id: crypto.randomUUID(),
        name,
        position: board?.columns.length ?? 0,
      });
    }
    if (!keepOpen) addingColumn = false;
    else columnInputEl?.focus();
  }

  function handleColumnComposerKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      commitColumnComposer(true);
    } else if (e.key === "Escape") {
      columnDraft = "";
      addingColumn = false;
    }
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
            labels={board.labels}
            planCards={merged?.columns.find((dc) => dc.column.id === column.id)?.planCards ?? []}
            onOpenPlanCard={(path) => (openPlanPath = path)}
            onRunCard={handleRun}
          />
        {:else}
          <div class="column-placeholder"></div>
        {/if}
      </div>
    {/each}
    {#each merged?.autoColumns ?? [] as auto (auto.status)}
      <AutoKanbanColumn status={auto.status} planCards={auto.planCards} labels={board.labels} {workspaceId} onOpenPlan={(path) => (openPlanPath = path)} onRunCard={handleRun} />
    {/each}
    {#if addingColumn}
      <input
        type="text"
        class="column-composer"
        placeholder="Column name…"
        bind:value={columnDraft}
        bind:this={columnInputEl}
        onkeydown={handleColumnComposerKeydown}
        onblur={() => commitColumnComposer(false)}
      />
    {:else}
      <button type="button" class="add-column" use:tooltip={"Add a column — its name becomes a status"} onclick={() => (addingColumn = true)}>+ Add column</button>
    {/if}
  </div>
  <KanbanDragPreview {board} {merged} labels={board.labels} root={boardEl} />
  {#if openPlan}
    <CardDetailModal
      card={openPlan}
      {workspaceId}
      columns={board.columns}
      labels={board.labels}
      {allCards}
      onClose={() => (openPlanPath = null)}
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
  .column-composer {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 8px;
    color: #eee;
    font-family: monospace;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    align-self: flex-start;
    box-sizing: border-box;
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
