<script lang="ts">
  import { untrack } from "svelte";
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, addColumnAction, reorderColumnAction, saveErrors, dismissSaveError } from "./kanbanState";
  import KanbanColumn from "./KanbanColumn.svelte";
  import AutoKanbanColumn from "./AutoKanbanColumn.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import CardComposeModal from "./CardComposeModal.svelte";
  import KanbanDragPreview from "./KanbanDragPreview.svelte";
  import { gavinTrees } from "./gavinState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import { planCommitFromMerged } from "./planDrop";
  import { runCard, resumeCard, sendToMainAgent } from "./cardRunActions";
  import { layoutState, daemonCompat } from "./layoutState";
  import { deletionPlanFor, executeDeletion, type DeletionPlan } from "./cardDelete";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import { openContextMenuFromEvent } from "./contextMenu";
  import { buildCardMenuEntries } from "./cardMenu";
  import { fetchOrchestration, orchestrations } from "./orchestrationState";
  import { cardSessionFor } from "./kanbanState";
  import { requestedCardDetail, takeCardDetailRequest } from "./cardTabLink";
  import { requestedCompose, takeComposeRequest, type ComposeTarget } from "./composeRequest";
  import { defaultComposeStatus } from "./cardCompose";
  import { attachBoardDrag } from "./kanbanDragGlue";
  import BoardSelectionBar from "./BoardSelectionBar.svelte";
  import { toggleCardSelected, clearBoardSelection } from "./boardSelection";
  import { dragState, buildColumnSlots, type ActiveDrag } from "./kanbanDrag";
  import SearchInput from "./ui/SearchInput.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { Archive } from "@lucide/svelte";
  import ArchiveGrid from "./ArchiveGrid.svelte";
  import { archiveView } from "./archive";
  import { executeUnarchive } from "./archiveActions";
  import { featureBlockedReason } from "./daemonCompat";
  import { filterBoard, AUTO_KEY_PREFIX } from "./boardSearch";
  import { isSearching } from "./search";
  import { railIndex } from "./planFilter";
  import { dropAgainstWholeBoard } from "./pageBoard";
  import {
    ANY,
    KIND_FACETS,
    NO_FACETS,
    NO_RAIL,
    contextFacets,
    facetsActive,
    filterBoardByFacets,
    filterCards,
    pruneFacets,
    type BoardFacets,
  } from "./boardFilters";
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
  const tree = $derived($gavinTrees[workspaceId]);
  const merged = $derived(board ? mergePlanCards(board, tree) : null);

  // --- the facet lens (boardFilters.ts) --------------------------------
  // Three dropdowns over the whole workspace's cards: which context, which
  // kind, which rail. `merged` stays UNFILTERED -- the delete cascade, the
  // detail modal and the drop path all commit against the whole board --
  // and the lenses compose facets first, then search, so a column's
  // "hidden" count keeps meaning "hidden by your query".
  let facets = $state<BoardFacets>({ ...NO_FACETS });
  const orch = $derived($orchestrations[workspaceId]);
  const rails = $derived(railIndex(orch ?? null));
  const contexts = $derived(contextFacets(tree));
  const filtering = $derived(facetsActive(facets));
  const faceted = $derived(merged ? filterBoardByFacets(merged, facets, rails) : null);

  // A facet whose option disappeared (the rail was deleted, the context
  // folder renamed) filters on a value the dropdown no longer offers, so
  // the board reads as empty for no stated reason. Each vocabulary is
  // passed only once its store has actually answered -- a null there
  // means "not loaded", never "the option is gone".
  $effect(() => {
    const next = pruneFacets(
      facets,
      tree && !tree.rootMissing ? contexts : null,
      orch === undefined ? null : rails
    );
    if (next.context !== facets.context || next.rail !== facets.rail) facets = next;
  });

  // The search lens, over what the facets left standing.
  let search = $state("");
  const searching = $derived(isSearching(search));
  const view = $derived(faceted ? filterBoard(faceted, search) : null);

  // What a column is NOT showing, across both lenses. A column header
  // reads this to say "3 / 11", and its Clear, Delete and Archive-all
  // refuse while it is non-zero -- so it has to count every card the
  // column is holding back, not just the ones a query hid. Summing is
  // exact rather than approximate: the search ran over what the facets
  // had already left, so the two counts are disjoint.
  function hiddenIn(columnKey: string): number {
    return (faceted?.hiddenIn(columnKey) ?? 0) + (view?.hiddenIn(columnKey) ?? 0);
  }

  // The archive lens. A toggle rather than a tab: it is the same board's
  // cards under the same search box, so switching must not cost the
  // human their query or their place in the workspace. The facets reach
  // it too -- an archive that ignored the context dropdown while the
  // board obeyed it would be two answers to one question.
  let showingArchive = $state(false);
  const archive = $derived(archiveView(filterCards(merged?.archived ?? [], facets, rails), search));
  const archiveBlocked = $derived(featureBlockedReason($daemonCompat, "archive"));

  // --- the card composer (CardComposeModal) ----------------------------
  // One per board, wherever the request came from: a column's "+ Add
  // card", its header menu, the board's own menu, or ⌘N. `composeStatus`
  // is the column the card will carry, and null means closed.
  let composeStatus = $state<string | null>(null);
  const composeSelf = $derived<ComposeTarget>({ kind: "hub", workspaceId });

  function openComposer(preferred: string | null): void {
    // Nothing to file a card into until the board has loaded; the
    // error line below only renders once it has.
    if (!board) return;
    // A card composed under a lens would be filed onto a board the human
    // cannot see -- the archive toggle, and equally a facet the new card
    // will not match (its context, its kind, and a card is born on no
    // rail at all). Every lens comes off with the composer.
    showingArchive = false;
    facets = { ...NO_FACETS };
    composeStatus = defaultComposeStatus(board.columns.map((c) => c.name), preferred);
    if (composeStatus === null) planWriteError = "Add a column first — a card needs a status to live in";
  }

  // ⌘N, routed here by composeRequest.ts. A second press while the
  // composer is already open must NOT reset the column picker under a
  // half-typed card, so the request is taken and dropped.
  $effect(() => {
    if (!takeComposeRequest($requestedCompose, composeSelf)) return;
    // untracked: the effect must depend on the REQUEST alone. Reading
    // composeStatus here would re-arm it on every open and close.
    untrack(() => {
      if (composeStatus === null) openComposer(null);
    });
  });

  // Every card view in the projection, nested children included -- the
  // detail modal must resolve a nested child's path too. The ARCHIVE is
  // in here as well: its cards are off the board but the grid opens,
  // deletes and selects them through exactly these paths.
  const allCards = $derived<CardView[]>(
    merged
      ? [
          ...merged.columns.flatMap((c) => c.planCards),
          ...merged.autoColumns.flatMap((a) => a.planCards),
          ...merged.archived,
        ].flatMap((c) => [c, ...c.nestedChildren])
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
      { label: "Add card", onPick: () => openComposer(null) },
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

  async function handleRestore(card: CardView): Promise<void> {
    planWriteError = null;
    const err = await executeUnarchive(workspaceId, [card]);
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
      // The drop names the slot the human saw, among the cards the facets
      // left standing; planDrop renumbers the WHOLE column.
      // dropAgainstWholeBoard reconciles the two -- without it a filtered
      // drop would reorder cards this board never showed.
      const commit = dropAgainstWholeBoard(drag, filtering ? faceted : null, merged);
      void planCommitFromMerged(workspaceId, commit, board.columns, merged).then((err) => {
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
      label={showingArchive ? "Search the archive" : "Search cards"}
      placeholder={showingArchive
        ? "Search the archive — title, file, status, label, context…"
        : "Search cards — title, file, status, label, context…"}
      matches={showingArchive
        ? { shown: archive.shown, total: archive.total }
        : view
          ? { shown: view.shown, total: view.total }
          : null}
      hint={showingArchive ? null : "filtered: clear to drag cards"}
    />
    <!-- The three facets, in the order a human narrows: WHERE the card
         lives, WHAT it is, WHICH rail runs it. Every one is always
         rendered, the way the Plans tab renders its own two -- a control
         that comes and goes with the workspace's shape is a control the
         human has to go looking for. -->
    <div class="facets">
      <select
        bind:value={facets.context}
        aria-label="Filter by context"
        use:tooltip={"Show only the cards in one context and its subfolders — the root is every card"}
      >
        {#each contexts as ctx (ctx.value)}
          <option value={ctx.value} title={ctx.folderPath}>{ctx.label}</option>
        {/each}
      </select>
      <select bind:value={facets.kind} aria-label="Filter by kind" use:tooltip={"Show only one kind of card"}>
        <option value={ANY}>Any kind</option>
        {#each KIND_FACETS as facet (facet.value)}
          <option value={facet.value}>{facet.label}</option>
        {/each}
      </select>
      <select
        bind:value={facets.rail}
        aria-label="Filter by rail"
        use:tooltip={"Show only the cards one orchestration rail carries"}
      >
        <option value={ANY}>Any rail</option>
        <option value={NO_RAIL}>On no rail</option>
        {#each rails.rails as rail (rail.id)}
          <option value={rail.id}>{rail.name}</option>
        {/each}
      </select>
      {#if filtering}
        <!-- Says how much the facets took off the BOARD, so a board that
             went short has a stated reason. Not shown over the archive,
             where that number would be about the cards behind it. -->
        {#if faceted && !showingArchive}
          <span class="facet-count" class:none={faceted.shown === 0}>{faceted.shown} / {faceted.total}</span>
        {/if}
        <!-- Clears the query too, the way the Plans tab's Reset does: the
             lenses stack, so a Reset that left one of them on would look
             like it had failed. -->
        <button
          type="button"
          class="reset"
          use:tooltip={"Clear the search and every filter"}
          onclick={() => {
            facets = { ...NO_FACETS };
            search = "";
          }}>Reset</button
        >
      {/if}
    </div>
    <IconButton
      icon={Archive}
      label={showingArchive ? "Back to the board" : "Open the archive"}
      variant="outlined"
      tone={showingArchive ? "accent" : "default"}
      size={12}
      active={showingArchive}
      class="archive-toggle"
      disabled={archiveBlocked !== null}
      tip={archiveBlocked ??
        (showingArchive
          ? "Back to the board"
          : `Archive — ${archive.total} ${archive.total === 1 ? "card" : "cards"} filed away, newest first`)}
      onclick={() => (showingArchive = !showingArchive)}
    >
      {#if archive.total > 0}<span class="archive-count">{archive.total}</span>{/if}
    </IconButton>
  </div>
  {#if showingArchive}
    <ArchiveGrid
      {workspaceId}
      cards={archive.cards}
      labels={board.labels}
      hiddenCount={archive.total - archive.shown}
      onOpenCard={(path) => (openPlanPath = path)}
      onRestore={(card) => void handleRestore(card)}
      onDeleteCard={(card) => (pendingDelete = card)}
      onCardContextMenu={handleCardContextMenu}
      restoreBlocked={archiveBlocked}
    />
  {:else}
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
            hiddenCount={hiddenIn(column.id)}
            onOpenPlanCard={(path) => (openPlanPath = path)}
            onRunCard={handleRun}
            onResumeCard={handleResume}
            onSendToAgent={handleSendToAgent}
            {agentAvailable}
            onDeleteCard={(card) => (pendingDelete = card)}
            onCardContextMenu={handleCardContextMenu}
            onAddCard={openComposer}
            {allCards}
          />
        {:else}
          <div class="column-placeholder"></div>
        {/if}
      </div>
    {/each}
    {#each view?.autoColumns ?? [] as auto (auto.status)}
      <AutoKanbanColumn status={auto.status} planCards={auto.planCards} hiddenCount={hiddenIn(AUTO_KEY_PREFIX + auto.status)} labels={board.labels} {workspaceId} onOpenPlan={(path) => (openPlanPath = path)} onRunCard={handleRun} onSendToAgent={handleSendToAgent} {agentAvailable} onDeleteCard={(card) => (pendingDelete = card)} onCardContextMenu={handleCardContextMenu} />
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
  {/if}
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
  {#if composeStatus !== null}
    <CardComposeModal
      {workspaceId}
      columns={board.columns}
      initialStatus={composeStatus}
      onRunCard={handleRun}
      onClose={() => (composeStatus = null)}
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
  /* The same first row the Orchestration tab draws: a rule under it so
     the lens reads as a bar over the board rather than as floating
     controls, and the search grows into the row instead of sitting at an
     input's default ~20-character width. */
  .board-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .board-bar :global(.board-search) {
    flex: 1 1 auto;
    max-width: 420px;
  }
  .board-bar :global(.archive-toggle) {
    flex: 0 0 auto;
  }
  .facets {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .facets select {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 160px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.72rem;
    padding: 2px 4px;
  }
  .facet-count {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }
  .facet-count.none {
    color: var(--warning-text);
  }
  .reset {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.72rem;
    padding: 2px 6px;
    cursor: pointer;
  }
  .reset:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .archive-count {
    font-family: monospace;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
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
