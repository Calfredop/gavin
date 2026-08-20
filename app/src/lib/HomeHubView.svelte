<script lang="ts">
  import { onMount } from "svelte";
  import { layoutState, switchWorkspaceView } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { boardSummary, planSummary, prdExcerpt } from "./homeSummary";
  import MainAgentPanel from "./MainAgentPanel.svelte";
  import * as backend from "./backend";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const EXCERPT_LINES = 15;

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const board = $derived($kanbanState[workspaceId]);
  const boards = $derived(boardSummary(board, tree));
  const plans = $derived(planSummary(tree));

  let prdLines = $state<string[]>([]);
  let agentFileExists = $state<boolean | null>(null);
  let agent = $state<{ fit: () => void } | null>(null);
  let gridEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void fetchBoard(workspaceId);
  });

  // Read on mount and whenever the bound root changes -- these panels are
  // summaries, not live views (D31), so they deliberately hold no watcher.
  $effect(() => {
    const r = root;
    if (!r) return;
    void backend
      .readFileForViewer(`${r}/.gavin-root/PRD.md`)
      .then((res) => (prdLines = prdExcerpt(res.content, EXCERPT_LINES)))
      .catch(() => (prdLines = []));
    void backend
      .readFileForViewer(`${r}/CLAUDE.md`)
      .then((res) => (agentFileExists = res.exists))
      .catch(() => (agentFileExists = null));
  });

  onMount(() => {
    if (!gridEl) return;
    const observer = new ResizeObserver(() => agent?.fit());
    observer.observe(gridEl);
    return () => observer.disconnect();
  });

  function go(view: string): void {
    void switchWorkspaceView(workspaceId, view);
  }
</script>

{#if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else}
  <div class="home">
    <div class="grid" bind:this={gridEl}>
      <div class="agent-cell">
        <MainAgentPanel bind:this={agent} {workspaceId} />
      </div>
      <div class="side">
        <button type="button" class="panel" onclick={() => go("prd")}>
          <span class="panel-head">PRD</span>
          {#if prdLines.length === 0}
            <span class="muted">No PRD yet.</span>
          {:else}
            <span class="excerpt">{prdLines.join("\n")}</span>
          {/if}
        </button>
        <button type="button" class="panel" onclick={() => go("kanban")}>
          <span class="panel-head">Board</span>
          {#if boards.columns.length === 0}
            <span class="muted">No board yet.</span>
          {:else}
            <span class="columns">
              {#each boards.columns as column (column.name)}
                <span class="column">
                  <span class="col-name">{column.name}</span>
                  <span class="col-count">{column.planCount}</span>
                </span>
              {/each}
              {#each boards.autoColumns as auto (auto.status)}
                <span class="column auto">
                  <span class="col-name">{auto.status}</span>
                  <span class="col-count">{auto.count}</span>
                </span>
              {/each}
            </span>
          {/if}
        </button>
      </div>
    </div>
    <div class="tiles">
      <button type="button" class="tile" onclick={() => go("prd")}>
        <b>PRD</b><span>{prdLines.length > 0 ? "present" : "not created"}</span>
      </button>
      <button type="button" class="tile" onclick={() => go("agent-file")}>
        <b>CLAUDE.md</b>
        <span>{agentFileExists === null ? "—" : agentFileExists ? "present" : "not set up"}</span>
      </button>
      <button type="button" class="tile" onclick={() => go("plans")}>
        <b>Plans</b>
        <span>{plans.total} plans · {plans.contexts} contexts</span>
      </button>
      <button type="button" class="tile" onclick={() => go("kanban")}>
        <b>Board</b><span>{boards.totalCards} cards</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .home {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 10px;
    gap: 10px;
    box-sizing: border-box;
  }
  .grid {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 10px;
    flex: 1 1 auto;
    min-height: 0;
  }
  .agent-cell {
    min-width: 0;
    min-height: 0;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .panel {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
    text-align: left;
    background: #1a1a1a;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    padding: 10px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
  }
  .panel:hover {
    border-color: #444;
  }
  .panel-head {
    color: #999;
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  .excerpt {
    white-space: pre-wrap;
    overflow: hidden;
    opacity: 0.85;
    line-height: 1.5;
  }
  .muted {
    color: #777;
  }
  .columns {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .column {
    display: flex;
    gap: 5px;
    align-items: baseline;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px 8px;
  }
  .column.auto {
    border-style: dashed;
  }
  .col-count {
    color: #8bc98b;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    flex: 0 0 auto;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
    background: transparent;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 8px 10px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.75em;
    cursor: pointer;
    text-align: left;
  }
  .tile:hover {
    border-color: #555;
  }
  .tile span {
    color: #888;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
  }
</style>
