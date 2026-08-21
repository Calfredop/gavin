<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import OrchestrationRail from "./OrchestrationRail.svelte";
  import OrchestrationConflicts from "./OrchestrationConflicts.svelte";
  import OrchestrationDragPreview from "./OrchestrationDragPreview.svelte";
  import OrchestrationDrawer from "./OrchestrationDrawer.svelte";
  import RailBindDialog from "./RailBindDialog.svelte";
  import ToolLibraryDialog from "./ToolLibraryDialog.svelte";
  import StepParamsDialog from "./StepParamsDialog.svelte";
  import { attachOrchestrationDrag } from "./orchestrationDragGlue";
  import Modal from "./Modal.svelte";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";
  import { layoutState, switchWorkspaceView } from "./layoutState";
  import {
    cardIndex,
    doneColumn,
    detectConflicts,
    numberConflicts,
    describeConflict,
    groupUnplacedByStatus,
    stepParams,
  } from "./orchestration";
  import { findTool, toolKindLabel } from "./orchestrationTools";
  import { toolRecords, fetchTools, refreshTools, renderLibraryFor } from "./toolsState";
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
    addToolAsStepAction,
    addToolAsStageAction,
    addToolToStageAction,
    setStepParamsAction,
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
  // renderLibraryFor, not libraryFor: while the fetch is in flight the
  // drawer shows the ten built-ins rather than an empty panel. The
  // SCHEDULER uses libraryFor, which can tell loading from empty.
  const tools = $derived(renderLibraryFor($toolRecords, workspaceId));

  let picking = $state<string | null>(null);
  let managingTools = $state(false);
  /// The tool step whose parameters are being edited, by step id.
  let editingParamsFor = $state<string | null>(null);
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
  const unplacedGroups = $derived(board ? groupUnplacedByStatus(available, board) : []);

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
    void fetchTools(workspaceId);
    void refreshTools(workspaceId);
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
    // A tool step launches only once the library has loaded, so the tick
    // has to re-run when it arrives -- otherwise an armed rail sitting
    // on a tool step would wait for some unrelated change.
    void $toolRecords[workspaceId];
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
  $effect(() => {
    if (!bodyEl || !gridEl) return;
    return attachOrchestrationDrag({
      root: bodyEl,
      scrollEl: gridEl,
      commit: (drag) => {
        // `id` is a step id for a step drag, a card path for a card
        // drag, and a tool id for a tool drag -- three sources, three
        // sets of mutators, one drop-target vocabulary.
        if (drag.kind === "card") {
          if (drag.target.kind === "into-stage") {
            void addStepToStageAction(workspaceId, drag.target.stageId, drag.id);
          } else if (drag.target.kind === "new-stage") {
            void addCardAsStageAction(workspaceId, drag.target.railId, drag.target.index, drag.id);
          }
          return;
        }
        if (drag.kind === "tool") {
          if (drag.target.kind === "into-stage") {
            void addToolToStageAction(workspaceId, drag.target.stageId, drag.id);
          } else if (drag.target.kind === "new-stage") {
            void addToolAsStageAction(workspaceId, drag.target.railId, drag.target.index, drag.id);
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
  const conflictSummary = $derived(
    orch
      ? numbered.map(({ n, conflict }) => `${n}. ${describeConflict(conflict, cards, orch, tools)}`)
      : []
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
    <button
      type="button"
      class="add-rail"
      disabled={!mainAgentRunning}
      title={mainAgentRunning ? "" : "Start the workspace agent on Home first"}
      onclick={() => void reorganize()}
    >
      Reorganize with agent…
    </button>
    <button type="button" class="add-rail" onclick={() => void newRail()}>
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
      {tools}
      onBindWorktree={(railId) => (binding = railId)}
      onMakeSequential={(stageId) => void makeStageSequentialAction(workspaceId, stageId)}
    />
  {/if}

  {#if !orch}
    <p class="empty">Loading…</p>
  {:else if rails.length === 0}
    <p class="empty">
      No rails yet. A rail is a column of stages over your cards — add one, then add steps to it.
    </p>
  {:else}
    <div class="body" bind:this={bodyEl}>
      <div class="grid" bind:this={gridEl}>
      {#each rails as rail (rail.id)}
        <OrchestrationRail
          {rail}
          {orch}
          {cards}
          {tools}
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
          onEditStepParams={(stepId) => (editingParamsFor = stepId)}
        />
      {/each}
      </div>
      <OrchestrationDrawer
        groups={unplacedGroups}
        {tools}
        targetRailId={rails[0]?.id ?? null}
        onAdd={(cardPath) => void addStepAsStageAction(workspaceId, rails[0].id, cardPath)}
        onAddTool={(toolId) => void addToolAsStepAction(workspaceId, rails[0].id, toolId)}
        onManageTools={() => (managingTools = true)}
      />
    </div>
  {/if}
</div>

<OrchestrationDragPreview {orch} {cards} {tools} dragRoot={bodyEl} />

{#if managingTools}
  <ToolLibraryDialog {workspaceId} {tools} onClose={() => (managingTools = false)} />
{/if}

{#if editingParamsFor && orch}
  {@const step = orch.rails
    .flatMap((r) => r.stages.flatMap((s) => s.steps))
    .find((t) => t.id === editingParamsFor)}
  {@const tool = step?.toolId ? findTool(tools, step.toolId) : undefined}
  {#if step && tool}
    <StepParamsDialog
      {tool}
      params={stepParams(step)}
      onSave={(params) => void setStepParamsAction(workspaceId, step.id, params)}
      onClose={() => (editingParamsFor = null)}
    />
  {/if}
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
      <!-- Both step kinds, because the drawer's click-to-add can only
           reach the FIRST rail; this picker is how a card or a tool
           lands on a specific one without dragging. -->
      <p class="pick-head">Cards</p>
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
      <p class="pick-head">Tools</p>
      <ul class="picker">
        {#each tools as tool (tool.id)}
          <li>
            <button
              type="button"
              onclick={() => {
                void addToolAsStepAction(workspaceId, railId, tool.id);
                picking = null;
              }}
            >
              <span class="pick-title">{tool.name}</span>
              <span class="pick-kind">{toolKindLabel(tool.kind)}</span>
            </button>
          </li>
        {/each}
      </ul>
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
    flex: 1;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
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
    max-height: 32vh;
    overflow-y: auto;
  }
  .pick-head {
    margin: 10px 0 4px;
    color: var(--text-subtle);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pick-head:first-of-type {
    margin-top: 0;
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
