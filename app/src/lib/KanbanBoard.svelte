<script lang="ts">
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, addColumnAction, reorderColumnAction, saveErrors, dismissSaveError } from "./kanbanState";
  import KanbanColumn from "./KanbanColumn.svelte";
  import AutoKanbanColumn from "./AutoKanbanColumn.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import { gavinTrees } from "./gavinState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import { planCommitFromMerged } from "./planDrop";
  import { runCard, resumeCard, sendToMainAgent } from "./cardRunActions";
  import { layoutState } from "./layoutState";
  import { deletionPlanFor, executeDeletion, type DeletionPlan } from "./cardDelete";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import { openContextMenuFromEvent } from "./contextMenu";
  import { buildCardMenuEntries } from "./cardMenu";
  import { fetchOrchestration } from "./orchestrationState";
  import { cardSessionFor } from "./kanbanState";
  import { requestedCardDetail, takeCardDetailRequest } from "./cardTabLink";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import BoardSelectionBar from "./BoardSelectionBar.svelte";
  import { toggleCardSelected, clearBoardSelection } from "./boardSelection";
  import { dragState, buildColumnSlots, type ActiveDrag } from "./kanbanDrag";
  import SearchInput from "./ui/SearchInput.svelte";
  import { filterBoard, AUTO_KEY_PREFIX } from "./boardSearch";
  import { isSearching } from "./search";
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

  // The rails, for the card menu's and the detail modal's "send to rail"
  // block -- this tab never mounts the Orchestration tab, so nothing else
  // would ever fetch them.
  $effect(() => {
    void fetchBoard(workspaceId);
    void fetchOrchestration(workspaceId);
  });

  // Deep link from a tab's card-link button: the tab set the request and
  // switched here, so this may be the effect's very first run.
  $effect(() => {
    const path = takeCardDetailRequest($requestedCardDetail, workspaceId, "kanban");
    if (path) openPlanPath = path;
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

  // The search lens. `merged` stays UNFILTERED -- the delete cascade, the
  // detail modal and the drop path all commit against the whole board --
  // and only the rendered columns come from `view`.
  let search = $state("");
  const searching = $derived(isSearching(search));
  const view = $derived(merged ? filterBoard(merged, search) : null);
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

  function handleBoardContextMenu(e: MouseEvent): void {
    openContextMenuFromEvent(e, [
      { label: "Add column", onPick: () => (addingColumn = true) },
      { label: "Refresh board", onPick: () => void refreshBoard(workspaceId) },
    ]);
  }

  async function handleRun(card: CardView): Promise<void> {
    planWriteError = null;
    const err = await runCard(workspaceId, card);
    if (err) planWriteError = err;
  }

  // The In Progress column's Resume (columnRunAction.ts): same spawn,
  // the prompt that tells the agent to pick the work up rather than
  // start it.
  async function handleResume(card: CardView): Promise<void> {
    planWriteError = null;
    const err = await resumeCard(workspaceId, card);
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
      // Cards do not drag while the board is filtered: the DOM no longer
      // holds every card, so the drop index would be measured against a
      // subset and written as a real `order`. Columns still drag.
      cardsLocked: () => searching,
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
  <!-- One flex column so the search bar can sit above a board that still
       fills the rest of the tab (the hub's .view host is a plain block). -->
  <div class="kanban">
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
  <div class="board-bar">
    <SearchInput
      bind:value={search}
      class="board-search"
      label="Search cards"
      placeholder="Search cards — title, file, status, label, context…"
      matches={view ? { shown: view.shown, total: view.total } : null}
      hint="filtered: clear to drag cards"
    />
  </div>
  <div class="board" bind:this={boardEl} oncontextmenu={handleBoardContextMenu} role="presentation">
    {#each buildColumnSlots(board.columns, (c) => c.id, $dragState) as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div class="column-slot" animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          {@const column = slot.item}
          <KanbanColumn
            {workspaceId}
            {column}
            labels={board.labels}
            planCards={view?.columns.find((dc) => dc.column.id === column.id)?.planCards ?? []}
            hiddenCount={view?.hiddenIn(column.id) ?? 0}
            onOpenPlanCard={(path) => (openPlanPath = path)}
            onRunCard={handleRun}
            onResumeCard={handleResume}
            onSendToAgent={handleSendToAgent}
            {agentAvailable}
            onDeleteCard={(card) => (pendingDelete = card)}
            onCardContextMenu={handleCardContextMenu}
            {allCards}
          />
        {:else}
          <div class="column-placeholder"></div>
        {/if}
      </div>
    {/each}
    {#each view?.autoColumns ?? [] as auto (auto.status)}
      <AutoKanbanColumn status={auto.status} planCards={auto.planCards} hiddenCount={view?.hiddenIn(AUTO_KEY_PREFIX + auto.status) ?? 0} labels={board.labels} {workspaceId} onOpenPlan={(path) => (openPlanPath = path)} onRunCard={handleRun} onSendToAgent={handleSendToAgent} {agentAvailable} onDeleteCard={(card) => (pendingDelete = card)} onCardContextMenu={handleCardContextMenu} />
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
  </div>
  <BoardSelectionBar {workspaceId} {allCards} onRunCard={handleRun} />
  <KanbanDragPreview {board} {merged} labels={board.labels} root={boardEl} />
  {#if pendingDelete}
    <ConfirmPrompt
      title={`Delete "${pendingDelete.title}"?`}
      lines={pendingDeleteLines}
      choices={[{ label: "Delete", danger: true, onPick: () => void confirmDelete() }]}
      onCancel={() => (pendingDelete = null)}
    />
  {/if}
  {#if openPlan}
    <CardDetailModal
      card={openPlan}
      {workspaceId}
      columns={board.columns}
      labels={board.labels}
      {allCards}
      onClose={() => (openPlanPath = null)}
      onPathChange={(path) => (openPlanPath = path)}
    />
  {/if}
{/if}

<style>
  .board-bar {
    display: flex;
    align-items: center;
    padding: 8px 16px 0;
    flex: 0 0 auto;
  }
  .board-bar :global(.board-search) {
    max-width: 520px;
  }
  .kanban {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .board {
    display: flex;
    gap: 12px;
    padding: 16px;
    overflow-x: auto;
    flex: 1 1 auto;
    min-height: 0;
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
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    background: var(--surface-sunken);
    align-self: stretch;
    box-sizing: border-box;
  }
  .add-column {
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    align-self: flex-start;
  }
  .column-composer {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
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
    border: 1px solid var(--border-warning);
    border-radius: 6px;
    color: var(--warning-text);
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
    color: var(--text);
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
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
