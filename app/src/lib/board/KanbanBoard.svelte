<script lang="ts">
  import { untrack } from "svelte";
  import { kanbanState, fetchBoard, refreshBoard, boardError, retryFetchBoard, addColumnAction, reorderColumnAction, saveErrors, dismissSaveError } from "$lib/board/kanbanState";
  import KanbanColumn from "$lib/board/KanbanColumn.svelte";
  import AutoKanbanColumn from "$lib/board/AutoKanbanColumn.svelte";
  import CardDetailModal from "$lib/cards/CardDetailModal.svelte";
  import CardComposeModal from "$lib/cards/CardComposeModal.svelte";
  import KanbanDragPreview from "$lib/board/KanbanDragPreview.svelte";
  import { gavinTrees } from "$lib/core/gavinState";
  import { flattenCardViews, mergePlanCards, type CardView } from "$lib/core/planBoard";
  import { planCommitFromMerged } from "$lib/files/planDrop";
  import { runCard, resumeCard, developCard, sendToMainAgent } from "$lib/cards/cardRunActions";
  import { layoutState, daemonCompat } from "$lib/core/layoutState";
  import {
    cardDeleteLines,
    columnDeletionPlan,
    deletionPlanFor,
    executeDeletion,
    type DeletionPlan,
  } from "$lib/cards/cardDelete";
  import { grantForAnsweredPrompt } from "$lib/core/confirmGate";
  import ConfirmPrompt from "$lib/core/ConfirmPrompt.svelte";
  import { openContextMenuFromEvent } from "$lib/core/contextMenu";
  import { buildCardMenuEntries } from "$lib/cards/cardMenu";
  import { fetchOrchestration, refreshOrchestration, orchestrations } from "$lib/orchestration/orchestrationState";
  import { cardSessionFor } from "$lib/board/kanbanState";
  import { requestedCardDetail, takeCardDetailRequest } from "$lib/cards/cardTabLink";
  import { requestedCompose, takeComposeRequest, type ComposeTarget } from "$lib/cards/composeRequest";
  import { defaultComposeStatus } from "$lib/cards/cardCompose";
  import { attachBoardDrag } from "$lib/board/kanbanDragGlue";
  import BoardSelectionBar from "$lib/board/BoardSelectionBar.svelte";
  import ArchiveSelectionBar from "$lib/files/ArchiveSelectionBar.svelte";
  import { boardSelection, selectedCards, toggleCardSelected, clearBoardSelection } from "$lib/board/boardSelection";
  import { dragState, buildColumnSlots, type ActiveDrag } from "$lib/board/kanbanDrag";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { Archive } from "@lucide/svelte";
  import ArchiveGrid from "$lib/files/ArchiveGrid.svelte";
  import ArchiveDeleteButton from "$lib/files/ArchiveDeleteButton.svelte";
  import { archiveView } from "$lib/files/archive";
  import {
    archivePurgeLines,
    archivePurgeTitle,
    bucketSubject,
    railStepsFor,
    SELECTION_SUBJECT,
    undatedCards,
    type AgeBucket,
  } from "$lib/files/archiveDelete";
  import { executeUnarchive } from "$lib/files/archiveActions";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import { filterBoard, hiddenAcross, AUTO_KEY_PREFIX } from "$lib/board/boardSearch";
  import { isSearching } from "$lib/core/search";
  import { railIndex } from "$lib/board/planFilter";
  import { dropAgainstWholeBoard } from "$lib/board/pageBoard";
  import {
    contextFacets,
    facetsActive,
    facetsEqual,
    filterBoardByFacets,
    filterCards,
    pruneFacets,
  } from "$lib/board/boardFilters";
  import { facetsFor, isTabLinked, hubFacetState, resetTabFacets, setTabFacets, setTabLinked } from "$lib/board/hubFacets";
  import FacetFilters from "$lib/board/FacetFilters.svelte";
  import { columnComposerKey, commitColumnDraft } from "$lib/board/columnComposer";
  import { flip } from "svelte/animate";
  import { tooltip } from "$lib/core/tooltip";
  import type { DropTarget } from "$lib/panes/pointerDrag";

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
  // Four checkbox dropdowns over the whole workspace's cards: which
  // contexts, which kinds, which rails, which labels. `merged` stays
  // UNFILTERED -- the delete cascade, the detail modal and the drop path
  // all commit against the whole board -- and the lenses compose facets
  // first, then search, so a column's "hidden" count keeps meaning
  // "hidden by your query".
  //
  // The facets themselves live in hubFacets.ts, not component `$state`:
  // Kanban, Review and Plans share one answer by default (a module-level
  // store survives this tab being torn down and rebuilt, which its own
  // `$state` would not), and this tab's Link button decides whether it is
  // reading the shared one or its own.
  const hub = $derived($hubFacetState[workspaceId]);
  const facets = $derived(facetsFor(hub, "kanban"));
  const facetsLinked = $derived(isTabLinked(hub, "kanban"));
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
      orch === undefined ? null : rails,
      board ? board.labels : null
    );
    if (!facetsEqual(next, facets)) {
      setTabFacets(workspaceId, "kanban", next);
    }
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
    return hiddenAcross([faceted, view], columnKey);
  }

  // The archive lens. A toggle rather than a tab: it is the same board's
  // cards under the same search box, so switching must not cost the
  // human their query or their place in the workspace. The facets reach
  // it too -- an archive that ignored the context dropdown while the
  // board obeyed it would be two answers to one question.
  let showingArchive = $state(false);
  const archive = $derived(archiveView(filterCards(merged?.archived ?? [], facets, rails), search));
  const archiveBlocked = $derived(featureBlockedReason($daemonCompat, "archive"));

  // Select mode, the Delete dropdown's "selected" route. Not a store:
  // it is one surface's way of reading clicks, and it must not survive
  // the human leaving the archive -- a grid that quietly kept picking
  // instead of opening cards is the worst mode to be stuck in.
  let archiveSelectMode = $state(false);

  function leaveArchiveSelectMode(): void {
    archiveSelectMode = false;
    clearBoardSelection();
  }

  // Every route out of the archive goes through here, including the
  // toggle -- the picks are meaningless off this grid, and Delete is the
  // one action they feed.
  function closeArchive(): void {
    showingArchive = false;
    leaveArchiveSelectMode();
  }

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
    closeArchive();
    resetTabFacets(workspaceId, "kanban");
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
  const allCards = $derived<CardView[]>(merged ? flattenCardViews(merged) : []);
  const openPlan = $derived<CardView | null>(
    openPlanPath ? (allCards.find((p) => p.id === openPlanPath) ?? null) : null
  );

  let pendingDelete = $state<CardView | null>(null);
  const pendingPlan = $derived<DeletionPlan | null>(
    pendingDelete ? deletionPlanFor(pendingDelete, allCards) : null
  );
  const pendingDeleteLines = $derived(
    pendingDelete && pendingPlan
      ? cardDeleteLines({
          fileName: pendingDelete.fileName,
          files: pendingPlan.files.length,
          unparent: pendingPlan.unparent.length,
          boundSession: pendingPlan.files.some((f) => cardSessionFor(board, f.id) !== null),
        })
      : []
  );

  async function confirmDelete(): Promise<void> {
    const plan = pendingPlan;
    pendingDelete = null;
    if (!plan) return;
    planWriteError = null;
    const token = await grantForAnsweredPrompt("delete_card_file", plan.files.map((f) => f.id));
    const err = await executeDeletion(workspaceId, plan, token);
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

  // --- deleting from the archive (archiveDelete.ts) --------------------
  // The archive is the one board surface whose cards nothing else will
  // ever clear: every other column empties into it. So it owns the only
  // BULK delete in the app, and it asks the same way a single card's
  // does -- one ConfirmPrompt, a `danger` choice, and lines that spell
  // out everything the grid cannot show.
  let pendingPurge = $state<{ cards: CardView[]; subject: string; undated: number } | null>(null);
  const purgeBlocked = $derived(featureBlockedReason($daemonCompat, "cardPurge"));
  const purgePlan = $derived<DeletionPlan | null>(
    pendingPurge ? columnDeletionPlan(pendingPurge.cards, allCards) : null
  );
  const purgeLines = $derived.by(() => {
    if (!pendingPurge || !purgePlan) return [];
    return archivePurgeLines({
      cards: pendingPurge.cards.length,
      files: purgePlan.files.length,
      unparent: purgePlan.unparent.length,
      railSteps: railStepsFor(orch, purgePlan.files),
      boundSessions: purgePlan.files.filter((f) => cardSessionFor(board, f.id) !== null).length,
      undated: pendingPurge.undated,
      purgeBlocked,
    });
  });

  function requestPurge(cards: CardView[], subject: string, undated: number): void {
    if (cards.length === 0) return;
    pendingPurge = { cards, subject, undated };
  }

  function requestBucketPurge(bucket: AgeBucket, matched: CardView[]): void {
    // The undated cards are named in the prompt because they are the one
    // thing an age sweep silently will NOT take.
    requestPurge(matched, bucketSubject(bucket), undatedCards(archive.cards).length);
  }

  // How many of the grid's own cards are picked. Named because three
  // surfaces read it -- the dropdown's row, the bar's presence, and the
  // delete itself -- and they must never disagree.
  const archivePicked = $derived(selectedCards(archive.cards, $boardSelection).length);

  function requestSelectionPurge(): void {
    // Intersected with the grid: the selection is app-wide, so a card
    // picked on the board behind the archive must never ride along.
    requestPurge(selectedCards(archive.cards, $boardSelection), SELECTION_SUBJECT, 0);
  }

  async function confirmPurge(): Promise<void> {
    const plan = purgePlan;
    pendingPurge = null;
    if (!plan) return;
    planWriteError = null;
    const token = await grantForAnsweredPrompt("delete_card_file", plan.files.map((f) => f.id));
    const err = await executeDeletion(workspaceId, plan, token);
    if (err) planWriteError = err;
    // The picks named files that are gone; leaving them would let a
    // second Delete count cards nobody can see.
    clearBoardSelection();
    // Rails lost their steps daemon-side (v34), and the app holds its own
    // copy until it is told -- the daemon pushes, and this covers the
    // window before that push lands.
    void refreshOrchestration(workspaceId);
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
    const { name, open, refocus } = commitColumnDraft(columnDraft, keepOpen);
    columnDraft = "";
    if (name) {
      void addColumnAction(workspaceId, {
        id: crypto.randomUUID(),
        name,
        position: board?.columns.length ?? 0,
      });
    }
    addingColumn = open;
    if (refocus) columnInputEl?.focus();
  }

  function handleColumnComposerKeydown(e: KeyboardEvent): void {
    const action = columnComposerKey(e.key);
    if (action === "commit") {
      e.preventDefault();
      commitColumnComposer(true);
    } else if (action === "cancel") {
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
    <!-- The four facets, in the order a human narrows: WHERE the card
         lives, WHAT it is, WHICH rail runs it, WHICH label it carries --
         shared with Review and Plans (hubFacets.ts) unless the Link
         button says otherwise. Every one is always rendered, the way
         the Plans tab renders its own two -- a control that comes and
         goes with the workspace's shape is a control the human has to
         go looking for. -->
    <div class="facets">
      <FacetFilters
        {facets}
        {contexts}
        {rails}
        labels={board.labels}
        linked={facetsLinked}
        onChange={(next) => setTabFacets(workspaceId, "kanban", next)}
        onToggleLink={() => setTabLinked(workspaceId, "kanban", !facetsLinked)}
      />
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
            resetTabFacets(workspaceId, "kanban");
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
      onclick={() => (showingArchive ? closeArchive() : (showingArchive = true))}
    >
      {#if archive.total > 0}<span class="archive-count">{archive.total}</span>{/if}
    </IconButton>
    <!-- Only over the archive: the buckets measure archived cards, and a
         Delete button sitting on the board would be a second, blunter
         way to do what every card's own menu already offers. -->
    {#if showingArchive}
      <ArchiveDeleteButton
        cards={archive.cards}
        filtered={filtering || archive.shown < archive.total}
        selectMode={archiveSelectMode}
        selectedCount={archivePicked}
        blocked={archiveBlocked}
        onEnterSelectMode={() => {
          clearBoardSelection();
          archiveSelectMode = true;
        }}
        onLeaveSelectMode={leaveArchiveSelectMode}
        onDeleteSelected={requestSelectionPurge}
        onDeleteBucket={requestBucketPurge}
      />
    {/if}
  </div>
  {#if showingArchive}
    <ArchiveGrid
      {workspaceId}
      cards={archive.cards}
      labels={board.labels}
      hiddenCount={archive.total - archive.shown}
      selectMode={archiveSelectMode}
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
  <!-- The archive's own bar stands INSTEAD of the board's: "Run
       selected" over cards the human archived is not a thing anyone
       means. It appears with the mode, and also for a bare shift+click
       selection, which is the other way picks get made here. -->
  {#if showingArchive && (archiveSelectMode || archivePicked > 0)}
    <ArchiveSelectionBar
      cards={archive.cards}
      onSelectAll={() => boardSelection.set(archive.cards.map((c) => c.id))}
      onDelete={requestSelectionPurge}
      onExit={leaveArchiveSelectMode}
    />
  {:else if !showingArchive}
    <BoardSelectionBar {workspaceId} {allCards} onRunCard={handleRun} />
  {/if}
  <KanbanDragPreview {board} {merged} labels={board.labels} root={boardEl} />
  {#if pendingDelete}
    <ConfirmPrompt
      title={`Delete "${pendingDelete.title}"?`}
      lines={pendingDeleteLines}
      choices={[{ label: "Delete", danger: true, onPick: () => void confirmDelete() }]}
      onCancel={() => (pendingDelete = null)}
    />
  {/if}
  {#if pendingPurge}
    <ConfirmPrompt
      title={archivePurgeTitle(pendingPurge.cards.length, pendingPurge.subject)}
      lines={purgeLines}
      choices={[{ label: "Delete permanently", danger: true, onPick: () => void confirmPurge() }]}
      onCancel={() => (pendingPurge = null)}
    />
  {/if}
  {#if composeStatus !== null}
    <CardComposeModal
      {workspaceId}
      columns={board.columns}
      initialStatus={composeStatus}
      {merged}
      onRunCard={handleRun}
      onDevelopCard={handleDevelop}
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
      onOpenCard={(path) => (openPlanPath = path)}
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
  .facets :global(.facet-link) {
    flex: 0 0 auto;
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
