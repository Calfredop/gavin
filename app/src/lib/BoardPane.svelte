<script lang="ts">
  import { untrack } from "svelte";
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, saveErrors, dismissSaveError } from "./kanbanState";
  import { gavinTrees } from "./gavinState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import KanbanColumn from "./KanbanColumn.svelte";
  import AutoKanbanColumn from "./AutoKanbanColumn.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import CardComposeModal from "./CardComposeModal.svelte";
  import { planCommitFromMerged } from "./planDrop";
  import { runCard, resumeCard, developCard, sendToMainAgent } from "./cardRunActions";
  import { layoutState } from "./layoutState";
  import { deletionPlanFor, executeDeletion, type DeletionPlan } from "./cardDelete";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import { openContextMenuFromEvent } from "./contextMenu";
  import { buildCardMenuEntries } from "./cardMenu";
  import { fetchOrchestration, orchestrations } from "./orchestrationState";
  import { cardSessionFor } from "./kanbanState";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import BoardSelectionBar from "./BoardSelectionBar.svelte";
  import { toggleCardSelected, clearBoardSelection } from "./boardSelection";
  import type { ActiveDrag } from "./kanbanDrag";
  import SearchInput from "./ui/SearchInput.svelte";
  import { filterBoard, AUTO_KEY_PREFIX } from "./boardSearch";
  import { isSearching } from "./search";
  import type { DropTarget } from "./pointerDrag";
  import { requestedCompose, takeComposeRequest, type ComposeTarget } from "./composeRequest";
  import { defaultComposeStatus } from "./cardCompose";
  import { dropAgainstWholeBoard, pageHolding, pageScope, scopeBoardToPage } from "./pageBoard";

  interface Props {
    workspaceId: string;
    contextFolder: string;
    visible: boolean;
    /// The tab this pane occupies. ⌘N addresses a board TAB, not a
    /// context: two panes can project the same folder, and only the
    /// focused one may answer.
    tabId?: string | null;
  }
  let { workspaceId, contextFolder, visible, tabId = null }: Props = $props();

  // Same contract FileViewerPane honors: Pane.svelte calls fit() on every
  // tab; a board has nothing to fit.
  export function fit(): void {}

  let openPlanPath = $state<string | null>(null);
  let planWriteError = $state<string | null>(null);
  let columnsEl = $state<HTMLElement | null>(null);

  // The rails, for the card menu's and the detail modal's "send to rail"
  // block -- this tab never mounts the Orchestration tab, so nothing else
  // would ever fetch them.
  $effect(() => {
    void fetchBoard(workspaceId);
    void fetchOrchestration(workspaceId);
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

  // The PAGE lens (pageBoard.ts). A board nested in a page IS that
  // page's board: it shows the cards bound to the page and nothing else.
  // The whole context's board is a click away on the hub's Kanban tab,
  // and projecting it here as well made this pane a second copy of it.
  //
  // A null page means the pane could not locate itself in any layout
  // tree. It then shows the whole context board -- the behaviour that
  // predates this lens -- rather than an empty one: a pane that cannot
  // say whose page it is on has no business hiding anything.
  //
  // Same posture until the orchestration plan lands: unknown is not
  // empty, and a board that blanks itself for a moment on every mount
  // -- then fills in -- reads as a bug, not as a lens.
  const page = $derived(pageHolding($layoutState.workspaces, tabId));
  const orch = $derived($orchestrations[workspaceId]);
  const scope = $derived(pageScope(page, board, orch));
  const scoped = $derived(merged && page && orch ? scopeBoardToPage(merged, scope.paths) : null);
  // Says out loud that this board is a lens, not the whole context --
  // otherwise a board missing most of its cards just looks broken.
  const scopeLabel = $derived(
    scoped ? ` · ${scoped.inScope} ${scoped.inScope === 1 ? "card" : "cards"} on this page` : ""
  );

  // Search lens -- see KanbanBoard: `merged` stays whole so the drop and
  // delete paths keep committing against the real board. Scope first,
  // then search, so a column's "hidden" count keeps meaning "hidden by
  // your query" rather than "not on this page".
  let search = $state("");
  const searching = $derived(isSearching(search));
  const view = $derived(merged ? filterBoard(scoped ?? merged, search) : null);
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

  // --- the card composer (CardComposeModal) ----------------------------
  // Same modal the hub board opens, with this pane's context pinned:
  // every card typed here belongs to the folder the pane projects.
  let composeStatus = $state<string | null>(null);
  const composeSelf = $derived<ComposeTarget | null>(
    tabId ? { kind: "tab", workspaceId, tabId } : null
  );

  // A page-scoped board can only keep a card bound to its page, and the
  // one binding the human can make while typing is a rail: the composer
  // files what it creates onto this page's rail (CardComposeModal's
  // pageRails). With no rail bound to the page there is nothing to open
  // -- a card typed here would vanish the instant it was written -- so
  // the column's + button goes away and ⌘N says why. The hub's Kanban
  // tab is where a free-standing card is made.
  const composerRails = $derived(page && orch ? scope.rails : null);
  const composerAvailable = $derived(composerRails === null || composerRails.length > 0);

  function openComposer(preferred: string | null): void {
    // Nothing to file a card into until the board has loaded; the
    // error line below only renders once it has.
    if (!board) return;
    // ⌘N reaches here even with the column's + button gone, so the
    // refusal says why rather than doing nothing at all.
    if (!composerAvailable) {
      planWriteError =
        "No rail is bound to this page, so a card made here would leave this board at once — the Kanban tab files cards for the whole context";
      return;
    }
    composeStatus = defaultComposeStatus(board.columns.map((c) => c.name), preferred);
    if (composeStatus === null) planWriteError = "Add a column first — a card needs a status to live in";
  }

  // ⌘N, routed here by composeRequest.ts. A second press while the
  // composer is already open must NOT reset the column picker under a
  // half-typed card, so the request is taken and dropped.
  $effect(() => {
    const self = composeSelf;
    if (!self || !takeComposeRequest($requestedCompose, self)) return;
    // untracked: the effect must depend on the REQUEST alone. Reading
    // composeStatus here would re-arm it on every open and close.
    untrack(() => {
      if (composeStatus === null) openComposer(null);
    });
  });

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

  // "Develop with agent on add" (CardComposeModal's Agent actions), and
  // the same call the card menu's "Develop into a plan…" makes: a card
  // filed as one line, handed straight to the gavin-develop skill. Not a
  // run -- developCard writes no status and binds no session -- so the
  // board shows nothing afterwards and the action jumps to the agent's
  // own tab instead.
  async function handleDevelop(card: CardView): Promise<void> {
    planWriteError = null;
    const err = await developCard(workspaceId, card);
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
    if (drag.kind !== "plan" || !board || !merged) return;
    planWriteError = null;
    // The drop names the slot the human saw, among the cards this page
    // shows; planDrop renumbers the WHOLE column. dropAgainstWholeBoard
    // reconciles the two -- without it a page-scoped drop would reorder
    // cards this board never showed.
    const commit = dropAgainstWholeBoard(drag, scoped, merged);
    void planCommitFromMerged(workspaceId, commit, board.columns, merged).then((err) => {
      if (err) planWriteError = err;
    });
  }

  $effect(() => {
    if (!columnsEl) return;
    return attachBoardDrag({
      root: columnsEl,
      allowColumns: false,
      commit: handleDragCommit,
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
    <div class="context-title" title={contextFolder}>
      {contextName}<span class="scope-count">{scopeLabel}</span>
    </div>
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
        label="Search cards"
        placeholder="Search cards…"
        matches={view ? { shown: view.shown, total: view.total } : null}
        hint="filtered: clear to drag"
      />
    </div>
    {#if scoped && scoped.inScope === 0 && !searching}
      <div class="scope-empty">
        Nothing is bound to this page yet. Cards appear here when a rail bound to this page carries
        them, or when you run one into a tab on this page. Every card in this context is on the
        Kanban tab.
      </div>
    {/if}
    <div class="columns" bind:this={columnsEl}>
      {#each view?.columns ?? [] as dc (dc.column.id)}
        <KanbanColumn
          {workspaceId}
          column={dc.column}
          mode="planOnly"
          labels={board.labels}
          planCards={dc.planCards}
          hiddenCount={view?.hiddenIn(dc.column.id) ?? 0}
          onOpenPlanCard={(path) => (openPlanPath = path)}
          onRunCard={handleRun}
          onResumeCard={handleResume}
          onSendToAgent={handleSendToAgent}
          {agentAvailable}
          onDeleteCard={(card) => (pendingDelete = card)}
          onCardContextMenu={handleCardContextMenu}
          onAddCard={composerAvailable ? openComposer : null}
          {allCards}
        />
      {/each}
      {#each view?.autoColumns ?? [] as auto (auto.status)}
        <AutoKanbanColumn status={auto.status} planCards={auto.planCards} hiddenCount={view?.hiddenIn(AUTO_KEY_PREFIX + auto.status) ?? 0} labels={board.labels} {workspaceId} onOpenPlan={(path) => (openPlanPath = path)} onRunCard={handleRun} onSendToAgent={handleSendToAgent} {agentAvailable} onDeleteCard={(card) => (pendingDelete = card)} onCardContextMenu={handleCardContextMenu} />
      {/each}
    </div>
    <BoardSelectionBar {workspaceId} {allCards} onRunCard={handleRun} />
    <KanbanDragPreview {board} {merged} labels={board.labels} root={columnsEl} />
  {/if}
  {#if composeStatus !== null && board}
    <CardComposeModal
      {workspaceId}
      columns={board.columns}
      initialStatus={composeStatus}
      pinnedContext={contextFolder}
      pageRails={composerRails}
      {merged}
      {scoped}
      onRunCard={handleRun}
      onDevelopCard={handleDevelop}
      onClose={() => (composeStatus = null)}
    />
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
      onOpenCard={(path) => (openPlanPath = path)}
      onPathChange={(path) => (openPlanPath = path)}
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
  .scope-count {
    opacity: 0.65;
  }
  .scope-empty {
    margin: 8px 12px 0;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
    line-height: 1.5;
    flex: 0 0 auto;
  }
  .board-bar {
    display: flex;
    align-items: center;
    padding: 6px 12px 0;
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
