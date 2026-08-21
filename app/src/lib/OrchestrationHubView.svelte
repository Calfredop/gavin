<script lang="ts">
  import { onMount } from "svelte";
  import { Plus } from "@lucide/svelte";
  import OrchestrationRail from "./OrchestrationRail.svelte";
  import OrchestrationConflicts from "./OrchestrationConflicts.svelte";
  import OrchestrationDragPreview from "./OrchestrationDragPreview.svelte";
  import OrchestrationDrawer from "./OrchestrationDrawer.svelte";
  import RailBindDialog from "./RailBindDialog.svelte";
  import { attachOrchestrationDrag } from "./orchestrationDragGlue";
  import Modal from "./Modal.svelte";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";
  import { layoutState } from "./layoutState";
  import { cardIndex, doneColumn, detectConflicts, numberConflicts } from "./orchestration";
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

  // onMount returns the detach function, so the engine is torn down with
  // the tab.
  onMount(() => {
    if (!gridEl) return;
    return attachOrchestrationDrag({
      root: gridEl,
      commit: (drag) => {
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

  function onStart(railId: string): void {
    const paused = orch?.railRuns.find((r) => r.railId === railId)?.state === "paused";
    void (paused ? resumeRail(workspaceId, railId) : startRail(workspaceId, railId));
  }
</script>

<div class="view">
  <header class="bar">
    <h2>Orchestration</h2>
    <button type="button" class="add-rail" onclick={() => void addRailAction(workspaceId, "New rail")}>
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
    <p class="empty">Loading…</p>
  {:else if rails.length === 0}
    <p class="empty">
      No rails yet. A rail is a column of stages over your cards — add one, then add steps to it.
    </p>
  {:else}
    <div class="body">
      <div class="grid" bind:this={gridEl}>
      {#each rails as rail (rail.id)}
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
          onBind={() => (binding = rail.id)}
          onAddStep={() => (picking = rail.id)}
          onRetryStep={(stepId) => void retryStep(workspaceId, stepId)}
          onRemoveStep={(stepId) => void removeStepAction(workspaceId, stepId)}
        />
      {/each}
      </div>
      <OrchestrationDrawer
        {available}
        targetRailId={rails[0]?.id ?? null}
        onAdd={(cardPath) => void addStepAsStageAction(workspaceId, rails[0].id, cardPath)}
      />
    </div>
  {/if}
</div>

<OrchestrationDragPreview {orch} {cards} root={gridEl} />

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
  .add-rail:hover {
    background: var(--surface-hover);
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
