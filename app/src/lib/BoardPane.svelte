<script lang="ts">
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, saveErrors, dismissSaveError } from "./kanbanState";
  import { gavinTrees } from "./gavinState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import KanbanColumn from "./KanbanColumn.svelte";
  import AutoKanbanColumn from "./AutoKanbanColumn.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import { planCommitFromMerged } from "./planDrop";
  import { runCard, sendToMainAgent } from "./cardRunActions";
  import { layoutState } from "./layoutState";
  import { deletionPlanFor, executeDeletion, type DeletionPlan } from "./cardDelete";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import { openContextMenuFromEvent } from "./contextMenu";
  import { buildCardMenuEntries } from "./cardMenu";
  import { cardSessionFor } from "./kanbanState";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import BoardSelectionBar from "./BoardSelectionBar.svelte";
  import { toggleCardSelected, clearBoardSelection } from "./boardSelection";
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

  let pendingDelete = $state<CardView | null>(null);
  const pendingPlan = $derived<DeletionPlan | null>(
    pendingDelete ? deletionPlanFor(pendingDelete, allCards) : null
  );
  const pendingDeleteLines = $derived.by(() => {
    if (!pendingDelete || !pendingPlan) return [];
    const lines = [`Deletes ${pendingDelete.fileName} permanently.`];
    const nested = pendingPlan.files.length - 1;
    if (nested > 0) lines.push(`Also deletes ${nested} nested ${nested === 1 ? "task" : "tasks"}.`);
    if (pendingPlan.unparent.length > 0)
      lines.push(`${pendingPlan.unparent.length} free-standing ${pendingPlan.unparent.length === 1 ? "task keeps" : "tasks keep"} their column (un-parented).`);
    if (pendingPlan.files.some((f) => cardSessionFor(board, f.id) !== null))
      lines.push("A bound agent session keeps running on the Agents page.");
    return lines;
  });

  async function confirmDelete(): Promise<void> {
    const plan = pendingPlan;
    pendingDelete = null;
    if (!plan) return;
    planWriteError = null;
    const err = await executeDeletion(workspaceId, plan);
    if (err) planWriteError = err;
  }

  function handleCardContextMenu(card: CardView, e: MouseEvent): void {
    if (!board) return;
    openContextMenuFromEvent(
      e,
      buildCardMenuEntries(card, {
        workspaceId,
        columns: board.columns,
        openDetail: (path) => (openPlanPath = path),
        requestDelete: (c) => (pendingDelete = c),
        run: (c) => void handleRun(c),
        sendToAgent: (c) => void handleSendToAgent(c),
        agentAvailable,
        reportError: (msg) => (planWriteError = msg),
      })
    );
  }

  async function handleRun(card: CardView): Promise<void> {
    planWriteError = null;
    const err = await runCard(workspaceId, card);
    if (err) planWriteError = err;
  }

  const agentAvailable = $derived(
    ($layoutState.workspaces.find((w) => w.id === workspaceId)?.mainSessionId ?? null) !== null
  );

  async function handleSendToAgent(card: CardView): Promise<void> {
    planWriteError = null;
    const err = await sendToMainAgent(workspaceId, card);
    if (err) planWriteError = err;
  }

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
      click: (kind, id, mods) => {
        if (kind !== "plan") return;
        // Shift picks cards for a batch run; a plain click still opens
        // the card, and drops any standing selection the way a file
        // list does.
        if (mods.shift) {
          toggleCardSelected(id);
        } else {
          clearBoardSelection();
          openPlanPath = id;
        }
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
          onRunCard={handleRun}
          onSendToAgent={handleSendToAgent}
          {agentAvailable}
          onDeleteCard={(card) => (pendingDelete = card)}
          onCardContextMenu={handleCardContextMenu}
          {allCards}
        />
      {/each}
      {#each merged?.autoColumns ?? [] as auto (auto.status)}
        <AutoKanbanColumn status={auto.status} planCards={auto.planCards} labels={board.labels} {workspaceId} onOpenPlan={(path) => (openPlanPath = path)} onRunCard={handleRun} onSendToAgent={handleSendToAgent} {agentAvailable} onDeleteCard={(card) => (pendingDelete = card)} onCardContextMenu={handleCardContextMenu} />
      {/each}
    </div>
    <BoardSelectionBar {workspaceId} {allCards} onRunCard={handleRun} />
    <KanbanDragPreview {board} {merged} labels={board.labels} root={columnsEl} />
  {/if}
  {#if pendingDelete}
    <ConfirmPrompt
      title={`Delete "${pendingDelete.title}"?`}
      lines={pendingDeleteLines}
      choices={[{ label: "Delete", danger: true, onPick: () => void confirmDelete() }]}
      onCancel={() => (pendingDelete = null)}
    />
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
    background: var(--surface-base);
    overflow: hidden;
  }
  .context-title {
    color: var(--success-text);
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
    border: 1px solid var(--border-warning);
    border-radius: 6px;
    color: var(--warning-text);
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
    color: var(--text);
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
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
