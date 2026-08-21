<script lang="ts">
  import { onMount } from "svelte";
  import { layoutState, switchWorkspaceView, agentProfilesStore, openWizard } from "./layoutState";
  import { resolveAgentConfig } from "./settings";
  import { setupProgress } from "./setupWizard";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { boardSummary, planSummary, prdExcerpt } from "./homeSummary";
  import MainAgentPanel from "./MainAgentPanel.svelte";
  import * as backend from "./backend";
  import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";
  import { changedCount } from "./git";

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
  // Named agentCfg, not agent: `agent` is already the MainAgentPanel
  // bind:this handle below.
  const agentCfg = $derived(
    resolveAgentConfig(tree?.contexts.find((c) => c.kind === "root")?.agent ?? null, $agentProfilesStore)
  );

  let prdLines = $state<string[]>([]);
  let agentFileExists = $state<boolean | null>(null);
  let agent = $state<{ fit: () => void } | null>(null);
  let gridEl = $state<HTMLElement | null>(null);

  // Whole bodies for the setup derivation; the summaries above are
  // derived from the same two reads.
  let prdBody = $state<string | null>(null);
  let agentFileBody = $state<string | null>(null);

  const setup = $derived(
    setupProgress({
      hasRoot: Boolean(root),
      configCommand: tree?.contexts.find((c) => c.kind === "root")?.agent?.command ?? null,
      agentFileBody,
      prdBody,
      mainSessionId: ws?.mainSessionId ?? null,
    })
  );

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
      .then((res) => {
        prdLines = prdExcerpt(res.content, EXCERPT_LINES);
        // Kept whole as well: setupProgress needs the body to tell a
        // written PRD from an untouched scaffold.
        prdBody = res.exists ? res.content : null;
      })
      .catch(() => {
        prdLines = [];
        prdBody = null;
      });
    void backend
      .readFileForViewer(`${r}/${agentCfg.file}`)
      .then((res) => {
        agentFileExists = res.exists;
        agentFileBody = res.exists ? res.content : null;
      })
      .catch(() => {
        agentFileExists = null;
        agentFileBody = null;
      });
    // One-shot git status for the tile — no watcher here; the Git tab
    // itself holds the live one.
    ensureGitView(workspaceId, r);
    void refreshGit(workspaceId);
  });

  const git = $derived($gitStore[workspaceId] ?? null);
  const gitLine = $derived(
    git?.gitMissing
      ? "git not found"
      : git?.repo?.notARepo
        ? "not a repository"
        : git?.status
          ? `${changedCount(git.status)} changes`
          : "—"
  );

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
    {#if root && !setup.complete}
      <button type="button" class="setup-card" onclick={() => openWizard(workspaceId)}>
        <b>Finish setting up this workspace</b>
        <span>{setup.done.length} of 4 done — continue</span>
      </button>
    {/if}
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
        <b>{agentCfg.file}</b>
        <span>{agentFileExists === null ? "—" : agentFileExists ? "present" : "not set up"}</span>
      </button>
      <button type="button" class="tile" onclick={() => go("plans")}>
        <b>Plans</b>
        <span>{plans.total} plans · {plans.contexts} contexts</span>
      </button>
      <button type="button" class="tile" onclick={() => go("kanban")}>
        <b>Board</b><span>{boards.totalCards} cards</span>
      </button>
      <button type="button" class="tile" onclick={() => go("git")}>
        <b>Git</b><span>{gitLine}</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .setup-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
    text-align: left;
    background: #1a1a1a;
    border: 1px solid #3a4a3a;
    border-radius: 8px;
    padding: 8px 10px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .setup-card span {
    color: #8bc98b;
  }
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
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
  }
  .panel:hover {
    border-color: var(--border);
  }
  .panel-head {
    color: var(--text-muted);
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
    color: var(--text-subtle);
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
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 8px;
  }
  .column.auto {
    border-style: dashed;
  }
  .col-count {
    color: var(--success-text);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    flex: 0 0 auto;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.75em;
    cursor: pointer;
    text-align: left;
  }
  .tile:hover {
    border-color: var(--border-strong);
  }
  .tile span {
    color: var(--text-subtle);
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
  }
</style>
