<script lang="ts">
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, saveErrors, dismissSaveError } from "./kanbanState";
  import { gavinTrees } from "./gavinState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import KanbanColumn from "./KanbanColumn.svelte";
  import AutoKanbanColumn from "./AutoKanbanColumn.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import { planCommitFromMerged } from "./planDrop";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import type { ActiveDrag } from "./kanbanDrag";
  import type { DropTarget } from "./pointerDrag";

  interface Props {
    workspaceId: string;
    contextFolder: string;
    visible: boolean;
  }
  let { workspaceId, contextFolder, visible }: Props = $props();

  // Same contract FileViewerPane honors: Pane.svelte calls fit() on every
  // tab; a board has nothing to fit.
  export function fit(): void {}

  let openPlanPath = $state<string | null>(null);
  let planWriteError = $state<string | null>(null);
  let columnsEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void fetchBoard(workspaceId);
  });

  // Staleness (spec §3): refetch when this pane is revealed and when the
  // window regains focus; refreshBoard's in-flight guard keeps it from
  // clobbering optimistic state.
  $effect(() => {
    if (visible) void refreshBoard(workspaceId);
  });
  $effect(() => {
    const onFocus = () => void refreshBoard(workspaceId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  const saveError = $derived($saveErrors[workspaceId] ?? null);

  const board = $derived($kanbanState[workspaceId]);
  const error = $derived(boardError(workspaceId));
  const tree = $derived($gavinTrees[workspaceId]);
  const contextExists = $derived(
    Boolean(tree && !tree.rootMissing && tree.contexts.some((c) => c.folderPath === contextFolder))
  );
  const contextName = $derived(
    tree?.contexts.find((c) => c.folderPath === contextFolder)?.name ??
      (contextFolder.split("/").at(-1) || contextFolder)
  );
  const merged = $derived(board ? mergePlanCards(board, tree, { contextFolder }) : null);
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

  function handleDragCommit(drag: ActiveDrag & { target: DropTarget }): void {
    if (drag.kind !== "plan" || !board || !merged) return;
    planWriteError = null;
    void planCommitFromMerged(workspaceId, drag, board.columns, merged).then((err) => {
      if (err) planWriteError = err;
    });
  }

  $effect(() => {
    if (!columnsEl) return;
    return attachBoardDrag({
      root: columnsEl,
      allowColumns: false,
      commit: handleDragCommit,
      click: (kind, id) => {
        if (kind === "plan") openPlanPath = id;
      },
    });
  });
</script>

<div class="board-pane" style:display={visible ? "flex" : "none"}>
  {#if error}
    <div class="overlay">
      <p>Couldn't load this board.</p>
      <p class="detail">{error}</p>
      <button onclick={() => retryFetchBoard(workspaceId)}>Retry</button>
    </div>
  {:else if !contextExists}
    <div class="overlay">
      <p>This context no longer exists.</p>
      <p class="detail">{contextFolder}</p>
    </div>
  {:else if !board}
    <div class="overlay"><p>Loading board…</p></div>
  {:else}
    <div class="context-title" title={contextFolder}>{contextName}</div>
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
    <div class="columns" bind:this={columnsEl}>
      {#each merged?.columns ?? [] as dc (dc.column.id)}
        <KanbanColumn
          {workspaceId}
          column={dc.column}
          mode="planOnly"
          labels={board.labels}
          planCards={dc.planCards}
          composerContext={contextFolder}
          onOpenPlanCard={(path) => (openPlanPath = path)}
        />
      {/each}
      {#each merged?.autoColumns ?? [] as auto (auto.status)}
        <AutoKanbanColumn status={auto.status} planCards={auto.planCards} labels={board.labels} onOpenPlan={(path) => (openPlanPath = path)} />
      {/each}
    </div>
    <KanbanDragPreview {board} {merged} labels={board.labels} root={columnsEl} />
  {/if}
  {#if openPlan && board}
    <CardDetailModal
      card={openPlan}
      {workspaceId}
      columns={board.columns}
      labels={board.labels}
      {allCards}
      onClose={() => (openPlanPath = null)}
    />
  {/if}
</div>

<style>
  .board-pane {
    position: absolute;
    inset: 0;
    flex-direction: column;
    background: #1e1e1e;
    overflow: hidden;
  }
  .context-title {
    color: #8bc98b;
    font-family: monospace;
    font-size: 0.8em;
    padding: 8px 12px 0;
    flex: 0 0 auto;
  }
  .columns {
    display: flex;
    gap: 12px;
    padding: 12px;
    overflow-x: auto;
    flex: 1 1 auto;
    min-height: 0;
    box-sizing: border-box;
    align-items: flex-start;
  }
  .plan-error {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 12px 0;
    padding: 6px 10px;
    border: 1px solid #a15c2f;
    border-radius: 6px;
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
    flex: 0 0 auto;
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
    word-break: break-all;
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
