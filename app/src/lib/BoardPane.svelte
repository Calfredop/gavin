<script lang="ts">
  import { kanbanState, fetchBoard, boardError, retryFetchBoard } from "./kanbanState";
  import { gavinTrees, patchPlanField } from "./gavinState";
  import { mergePlanCards, type PlanCardView } from "./planBoard";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";
  import PlanDetailModal from "./PlanDetailModal.svelte";
  import * as backend from "./backend";
  import { getDragKind, getDragPayload } from "./dragDrop";

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

  $effect(() => {
    void fetchBoard(workspaceId);
  });

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
  const openPlan = $derived<PlanCardView | null>(
    merged && openPlanPath
      ? ([...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].find(
          (p) => p.id === openPlanPath
        ) ?? null)
      : null
  );

  async function setPlanStatus(path: string, columnName: string): Promise<void> {
    planWriteError = null;
    const fileName = path.split("/").at(-1) ?? path;
    try {
      await backend.setPlanFrontmatterField(path, "status", columnName);
      patchPlanField(workspaceId, path, "status", columnName);
    } catch (e) {
      planWriteError = `Couldn't update ${fileName}: ${e}`;
    }
  }

  function allowPlanDrop(event: DragEvent): void {
    if (getDragKind(event) === "plan-card") event.preventDefault();
  }

  function dropOn(event: DragEvent, statusName: string): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (payload?.kind === "plan-card") void setPlanStatus(payload.path, statusName);
  }
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
    <div class="columns">
      {#each merged?.columns ?? [] as dc (dc.column.id)}
        <div class="column" role="list" ondragover={allowPlanDrop} ondrop={(e) => dropOn(e, dc.column.name)}>
          <div class="header">{dc.column.name}</div>
          {#each dc.planCards as plan (plan.id)}
            <PlanKanbanCard {plan} onOpen={() => (openPlanPath = plan.id)} />
          {/each}
        </div>
      {/each}
      {#each merged?.autoColumns ?? [] as auto (auto.status)}
        <div class="column auto" role="list" ondragover={allowPlanDrop} ondrop={(e) => dropOn(e, auto.status)}>
          <div class="header">{auto.status}</div>
          {#each auto.planCards as plan (plan.id)}
            <PlanKanbanCard {plan} onOpen={() => (openPlanPath = plan.id)} />
          {/each}
        </div>
      {/each}
    </div>
  {/if}
  {#if openPlan}
    <PlanDetailModal plan={openPlan} {workspaceId} onClose={() => (openPlanPath = null)} />
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
  }
  .column {
    background: #252525;
    border-radius: 8px;
    padding: 8px;
    width: 220px;
    flex: 0 0 auto;
    align-self: flex-start;
    max-height: 100%;
    overflow-y: auto;
    font-family: monospace;
    box-sizing: border-box;
  }
  .column.auto {
    border: 1px dashed #555;
  }
  .header {
    color: #ccc;
    font-size: 0.85em;
    margin-bottom: 8px;
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
