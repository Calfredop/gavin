<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import OrchestrationRail from "./OrchestrationRail.svelte";
  import OrchestrationConflicts from "./OrchestrationConflicts.svelte";
  import OrchestrationDragPreview from "./OrchestrationDragPreview.svelte";
  import OrchestrationDrawer from "./OrchestrationDrawer.svelte";
  import RailBindDialog from "./RailBindDialog.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import { searchOrchestration } from "./orchestrationSearch";
  import { attachOrchestrationDrag } from "./orchestrationDragGlue";
  import Modal from "./Modal.svelte";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import { requestedCardDetail, takeCardDetailRequest } from "./cardTabLink";
  import { layoutState, daemonCompat, switchWorkspaceView } from "./layoutState";
  import { featureBlockedReason } from "./daemonCompat";
  import {
    cardIndex,
    doneColumn,
    detectConflicts,
    numberConflicts,
    describeConflict,
    groupUnplacedByStatus,
  } from "./orchestration";
  import {
    orchestrations,
    fetchOrchestration,
    refreshOrchestration,
    saveErrors,
    dismissSaveError,
    addRailAction,
    deleteRailAction,
    addStepAsStageAction,
    removeStepAction,
    startRail,
    pauseRail,
    resumeRail,
    resetRail,
    retryStep,
    tick,
    makeStageSequentialAction,
    moveStepIntoStageAction,
    moveStepToNewStageAction,
    addCardAsStageAction,
    addStepToStageAction,
    requestReorganize,
    renameRailAction,
  } from "./orchestrationState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath ?? null);
  const orch = $derived($orchestrations[workspaceId] ?? null);
  const board = $derived($kanbanState[workspaceId] ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const cards = $derived(cardIndex(tree));
  const doneName = $derived(board ? (doneColumn(board)?.name ?? null) : null);
  const rails = $derived([...(orch?.rails ?? [])].sort((a, b) => a.position - b.position));
  // null, not [], while the refs snapshot is still loading -- unknown
  // must not read as "every worktree is gone".
  const worktrees = $derived($gitStore[workspaceId]?.refs?.worktrees ?? null);
  const numbered = $derived(orch ? numberConflicts(detectConflicts(orch, tree, worktrees)) : []);

  // The card detail modal, opened from a tab's card-link button (and
  // from a step chip's own menu once it has one): a step is a card, and
  // the human should not have to cross to the board to read it. The
  // projection is the board's own -- same modal, same columns, same
  // nested children -- so nothing about a card reads differently here.
  let openPlanPath = $state<string | null>(null);
  const merged = $derived(board ? mergePlanCards(board, tree) : null);
  const allCards = $derived<CardView[]>(
    merged
      ? [...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].flatMap(
          (c) => [c, ...c.nestedChildren]
        )
      : []
  );
  const openPlan = $derived<CardView | null>(
    openPlanPath ? (allCards.find((c) => c.id === openPlanPath) ?? null) : null
  );

  $effect(() => {
    const path = takeCardDetailRequest($requestedCardDetail, workspaceId, "orchestration");
    if (path) openPlanPath = path;
  });

  let picking = $state<string | null>(null);
  // The rail whose bindings are being edited, set by the rail header and
  // by the conflicts box's inline fix.
  let binding = $state<string | null>(null);

  // The cards a rail can take on: every runnable card not already on one.
  const placed = $derived(
    new Set((orch?.rails ?? []).flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.cardPath))))
  );
  const available = $derived(
    [...cards.values()].filter((e) => e.plan.kind !== "note" && !placed.has(e.plan.path))
  );
  const allUnplacedGroups = $derived(board ? groupUnplacedByStatus(available, board) : []);

  // The search lens (orchestrationSearch.ts): rails with no hit leave
  // the grid, matching chips light up inside the rails that stay, and
  // the drawer filters like any other list.
  let search = $state("");
  const lens = $derived(searchOrchestration(orch, cards, search));
  const unplaced = $derived(lens.filterUnplaced(allUnplacedGroups));
  const unplacedGroups = $derived(unplaced.groups);
  const shownRails = $derived(rails.filter((r) => lens.railShown(r.id)));
  // A plain boolean, not `lens.filtering`: `lens` is a fresh object on
  // every keystroke, and the drag effect below would then tear down and
  // re-attach the engine on each one. A derived primitive only notifies
  // when it actually flips.
  const filtering = $derived(lens.filtering);

  // Which rail's name is being edited. Owned here so a rail created by
  // the button below can open straight into rename mode.
  let editingRailId = $state<string | null>(null);

  async function newRail(): Promise<void> {
    editingRailId = await addRailAction(workspaceId, "New rail");
  }

  $effect(() => {
    void fetchOrchestration(workspaceId);
    void fetchBoard(workspaceId);
    void refreshOrchestration(workspaceId);
    if (root) {
      ensureGitView(workspaceId, root);
      void refreshGit(workspaceId);
    }
  });

  // Re-tick whenever anything the scheduler reads changes: card statuses
  // arrive on gavin-tree-changed pushes, sessions come and go in the
  // layout, and the board decides what "done" means.
  $effect(() => {
    void $gavinTrees[workspaceId];
    void $layoutState.workspaces;
    void $kanbanState[workspaceId];
    void tick(workspaceId);
  });

  let gridEl = $state<HTMLElement | null>(null);
  // Listening happens on the row that holds BOTH the grid and the drawer,
  // so a card can be dragged from one into the other.
  let bodyEl = $state<HTMLElement | null>(null);

  // $effect, NOT onMount: the elements below live inside the loaded
  // branch, so at mount time the plan is still being fetched and both
  // binds are null. onMount would early-return and never run again --
  // the drag engine would simply never attach. KanbanBoard attaches the
  // same way for the same reason. The returned teardown runs when the
  // elements change or the tab unmounts.
  // Drag is off while the grid is filtered: rails and drawer rows leave
  // the DOM, and a new-stage index measured over what is left would drop
  // the step at the wrong position. Re-attaches the moment the box is
  // cleared. (Nothing else rides this engine here -- its click callback
  // is a no-op -- so simply not attaching is the whole lock.)
  $effect(() => {
    if (!bodyEl || !gridEl || filtering) return;
    return attachOrchestrationDrag({
      root: bodyEl,
      scrollEl: gridEl,
      commit: (drag) => {
        // `id` is a step id for a step drag and a card path for a card
        // drag -- the two commit into different mutators entirely.
        if (drag.kind === "card") {
          if (drag.target.kind === "into-stage") {
            void addStepToStageAction(workspaceId, drag.target.stageId, drag.id);
          } else if (drag.target.kind === "new-stage") {
            void addCardAsStageAction(workspaceId, drag.target.railId, drag.target.index, drag.id);
          }
          return;
        }
        if (drag.target.kind === "unplace") {
          void removeStepAction(workspaceId, drag.id);
        } else if (drag.target.kind === "into-stage") {
          void moveStepIntoStageAction(workspaceId, drag.id, drag.target.stageId);
        } else {
          void moveStepToNewStageAction(workspaceId, drag.id, drag.target.railId, drag.target.index);
        }
      },
      // A press with no movement does nothing here: the chip's own
      // buttons handle clicks, and the glue already ignores pointerdowns
      // that land on a button.
      click: () => {},
    });
  });

  const mainAgentRunning = $derived(Boolean(ws?.mainSessionId));
  // Every orchestration write (SetOrchestration/SetRailRun/SetStepRun) is
  // gated at protocol v10 (see protocol::min_version_for) -- against an
  // older daemon these buttons would otherwise dispatch requests the wire
  // guard in session.rs's `gate` silently refuses, with no explanation.
  // Reusing the same featureBlockedReason the banner is built from keeps
  // the wording (and the version numbers) identical wherever the app
  // names this.
  const orchestrationBlocked = $derived(featureBlockedReason($daemonCompat, "orchestration"));
  const conflictSummary = $derived(
    orch ? numbered.map(({ n, conflict }) => `${n}. ${describeConflict(conflict, cards, orch)}`) : []
  );

  async function reorganize(): Promise<void> {
    const err = await requestReorganize(workspaceId, conflictSummary);
    if (err) {
      saveErrors.update((e) => ({ ...e, [workspaceId]: err }));
      return;
    }
    await switchWorkspaceView(workspaceId, "home");
  }

  function onStart(railId: string): void {
    const paused = orch?.railRuns.find((r) => r.railId === railId)?.state === "paused";
    void (paused ? resumeRail(workspaceId, railId) : startRail(workspaceId, railId));
  }
</script>

<div class="view">
  <header class="bar">
    <h2>Orchestration</h2>
    <SearchInput
      bind:value={search}
      class="bar-search"
      label="Search rails and cards"
      placeholder="Search rails, steps, unplaced cards…"
    />
    {#if lens.filtering}
      <span class="summary">
        {lens.railsShown} {lens.railsShown === 1 ? "rail" : "rails"} ·
        {lens.stepsMatched} {lens.stepsMatched === 1 ? "step" : "steps"} ·
        {unplaced.shown} unplaced
      </span>
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="add-rail"
      disabled={!mainAgentRunning || Boolean(orchestrationBlocked)}
      title={orchestrationBlocked || (mainAgentRunning ? "" : "Start the workspace agent on Home first")}
      onclick={() => void reorganize()}
    >
      Reorganize with agent…
    </button>
    <button
      type="button"
      class="add-rail"
      disabled={Boolean(orchestrationBlocked)}
      title={orchestrationBlocked ?? ""}
      onclick={() => void newRail()}
    >
      <Plus size={14} /> Rail
    </button>
  </header>

  {#if $saveErrors[workspaceId]}
    <div class="save-error">
      <span>{$saveErrors[workspaceId]}</span>
      <button type="button" onclick={() => dismissSaveError(workspaceId)}>Dismiss</button>
    </div>
  {/if}

  {#if orch}
    <OrchestrationConflicts
      {numbered}
      {cards}
      {orch}
      onBindWorktree={(railId) => (binding = railId)}
      onMakeSequential={(stageId) => void makeStageSequentialAction(workspaceId, stageId)}
    />
  {/if}

  {#if !orch}
    {#if orchestrationBlocked}
      <p class="empty">{orchestrationBlocked}</p>
    {:else}
      <p class="empty">Loading…</p>
    {/if}
  {:else if rails.length === 0}
    <p class="empty">
      No rails yet. A rail is a column of stages over your cards — add one, then add steps to it.
    </p>
  {:else}
    <div class="body" bind:this={bodyEl}>
      <div class="grid" bind:this={gridEl}>
      {#if lens.filtering && shownRails.length === 0}
        <p class="empty">No rail matches this search.</p>
      {/if}
      {#each shownRails as rail (rail.id)}
        <OrchestrationRail
          {rail}
          {orch}
          {cards}
          doneColumnName={doneName}
          {numbered}
          onStart={() => onStart(rail.id)}
          onPause={() => void pauseRail(workspaceId, rail.id)}
          onReset={() => void resetRail(workspaceId, rail.id)}
          onDelete={() => void deleteRailAction(workspaceId, rail.id)}
          pageName={ws?.pages.find((p) => p.id === rail.pageId)?.name ?? null}
          editing={editingRailId === rail.id}
          onStartEdit={() => (editingRailId = rail.id)}
          onRename={(name) => {
            void renameRailAction(workspaceId, rail.id, name);
            editingRailId = null;
          }}
          onCancelEdit={() => (editingRailId = null)}
          onBind={() => (binding = rail.id)}
          onAddStep={() => (picking = rail.id)}
          onRetryStep={(stepId) => void retryStep(workspaceId, stepId)}
          onRemoveStep={(stepId) => void removeStepAction(workspaceId, stepId)}
          filtering={lens.filtering}
          stepLit={lens.stepLit}
        />
      {/each}
      </div>
      <OrchestrationDrawer
        groups={unplacedGroups}
        filtering={lens.filtering}
        hiddenCount={unplaced.total - unplaced.shown}
        targetRailId={rails[0]?.id ?? null}
        onAdd={(cardPath) => void addStepAsStageAction(workspaceId, rails[0].id, cardPath)}
      />
    </div>
  {/if}
</div>

<OrchestrationDragPreview {orch} {cards} dragRoot={bodyEl} />

{#if openPlan && board}
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

{#if binding && orch}
  {@const bindingRail = orch.rails.find((r) => r.id === binding)}
  {#if bindingRail}
    <RailBindDialog {workspaceId} rail={bindingRail} onClose={() => (binding = null)} />
  {/if}
{/if}

{#if picking}
  {@const railId = picking}
  <Modal onClose={() => (picking = null)}>
    <div class="picker-body">
      <h3>Add a step</h3>
      {#if available.length === 0}
        <p class="empty">Every runnable card is already on a rail.</p>
      {:else}
        <ul class="picker">
          {#each available as entry (entry.plan.path)}
            <li>
              <button
                type="button"
                onclick={() => {
                  void addStepAsStageAction(workspaceId, railId, entry.plan.path);
                  picking = null;
                }}
              >
                <span class="pick-title">{entry.plan.title}</span>
                <span class="pick-kind">{entry.plan.kind}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Modal>
{/if}

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-base);
    color: var(--text);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    flex: 0 0 auto;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .bar :global(.bar-search) {
    flex: 1 1 auto;
    max-width: 420px;
  }
  .summary {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .add-rail {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .add-rail:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .add-rail:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  .save-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--surface-danger);
    border-bottom: 1px solid var(--border-danger);
    color: var(--danger-text);
    font-size: 12px;
  }
  .save-error button {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .empty {
    padding: 16px 12px;
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  /* Rails are grid columns and stage index is the row track, so a
     horizontal band across the grid reads as roughly concurrent
     (orchestration spec O8). */
  .grid {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(280px, 1fr);
    overflow: auto;
    align-items: start;
  }
  .picker-body {
    min-width: 320px;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .picker {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }
  .picker button {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 8px;
    padding: 6px 8px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .picker button:hover {
    background: var(--surface-hover);
  }
  .pick-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick-kind {
    color: var(--text-subtle);
    font-size: 11px;
  }
</style>
