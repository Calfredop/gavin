<script lang="ts">
  import { onMount } from "svelte";
  import { layoutState, switchWorkspaceView, agentProfilesStore, openWizard, agentModelDefaultsStore} from "./layoutState";
  import { resolveAgentConfig, resolvePrdPath } from "./settings";
  import { setupProgress, SETUP_STEPS } from "./setupWizard";
  import { UNKNOWN_STATUS, type SuperpowersMark, type SuperpowersStatus } from "./superpowers";
  import { gavinTrees, refreshGavinTree } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { boardSummary, planSummary, prdExcerpt, orchestrationSummary } from "./homeSummary";
  import MainAgentPanel from "./MainAgentPanel.svelte";
  import * as backend from "./backend";
  import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";
  import { changedCount } from "./git";
  import { orchestrations, fetchOrchestration } from "./orchestrationState";

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
    resolveAgentConfig(
      tree?.contexts.find((c) => c.kind === "root")?.agent ?? null,
      $agentProfilesStore,
      $agentModelDefaultsStore
    )
  );
  // The excerpt has to come from the file the workspace actually points
  // at, or a project with its own docs/PRD.md shows an empty tile beside
  // a PRD tab full of prose.
  const prdPath = $derived(resolvePrdPath(tree?.contexts.find((c) => c.kind === "root")));

  let prdLines = $state<string[]>([]);
  let agentFileExists = $state<boolean | null>(null);
  let agent = $state<{ fit: () => void } | null>(null);
  let gridEl = $state<HTMLElement | null>(null);

  // Whole bodies for the setup derivation; the summaries above are
  // derived from the same two reads. undefined until the read lands --
  // null already means "no such file", and this panel remounts on every
  // visit to the home tab, so starting them at null announced a
  // half-finished setup for the length of two IPC round trips.
  let prdBody = $state<string | null | undefined>(undefined);
  let agentFileBody = $state<string | null | undefined>(undefined);
  // Same unknown-until-read rule for the third input: the banner counts
  // the Superpowers step too, and a check still running must not be
  // rendered as a step left undone.
  let superpowers = $state<SuperpowersStatus | undefined>(undefined);
  let superpowersMark = $state<SuperpowersMark | undefined>(undefined);

  const setup = $derived(
    setupProgress({
      hasRoot: Boolean(root),
      configCommand: tree?.contexts.find((c) => c.kind === "root")?.agent?.command ?? null,
      agentFileBody,
      prdBody,
      mainSessionId: ws?.mainSessionId ?? null,
      superpowers,
      superpowersMark,
    })
  );

  $effect(() => {
    void fetchBoard(workspaceId);
    // One read; the app-wide `orchestration-changed` listener keeps the
    // recap current from there, so this panel needs no watcher either.
    void fetchOrchestration(workspaceId);
  });

  // Both paths below are read off the tree, and bootstrap flips the app
  // to "ready" BEFORE it starts the watcher -- so a cold start renders
  // this panel with no tree at all and would read the fallback paths
  // instead of the configured ones. Waiting for it is only safe because
  // of the rescan: a watch that failed outright never produces a push,
  // and without a second way to settle it this panel would wait forever.
  let treeSettled = $state(false);
  let treeToken = 0;
  $effect(() => {
    if (tree) {
      treeSettled = true;
      return;
    }
    treeSettled = false;
    const mine = ++treeToken;
    // Resolved either way: on success the store fills and the branch
    // above settles it, on failure there is nothing left to wait for.
    void refreshGavinTree(workspaceId).finally(() => {
      if (mine === treeToken) treeSettled = true;
    });
  });

  // Read on mount and whenever the bound root changes -- these panels are
  // summaries, not live views (D31), so they deliberately hold no watcher.
  let readToken = 0;
  $effect(() => {
    const r = root;
    // Back to unknown FIRST, before any early return: a re-pointed root --
    // or a switch to a workspace whose tree has not landed -- makes the
    // last root's bodies say nothing about this one, and leaving them up
    // would draw the previous workspace's setup answer on this one.
    // Bumping the token in the same breath drops any read still in
    // flight, whose answer belongs to the root we just left.
    prdBody = undefined;
    agentFileBody = undefined;
    superpowers = undefined;
    superpowersMark = undefined;
    const mine = ++readToken;
    if (!r || !treeSettled) return;
    void backend
      .readFileForViewer(`${r}/${prdPath}`)
      .then((res) => {
        if (mine !== readToken) return;
        prdLines = prdExcerpt(res.content, EXCERPT_LINES);
        // Kept whole as well: setupProgress needs the body to tell a
        // written PRD from an untouched scaffold.
        prdBody = res.exists ? res.content : null;
      })
      .catch(() => {
        if (mine !== readToken) return;
        prdLines = [];
        prdBody = null;
      });
    void backend
      .readFileForViewer(`${r}/${agentCfg.file}`)
      .then((res) => {
        if (mine !== readToken) return;
        agentFileExists = res.exists;
        agentFileBody = res.exists ? res.content : null;
      })
      .catch(() => {
        if (mine !== readToken) return;
        agentFileExists = null;
        agentFileBody = null;
      });
    // Marker first, detector only if there is no marker. The banner just
    // needs to know whether the step is answered, and a recorded answer
    // settles it on its own -- whereas the detector is a SUBPROCESS, and
    // this panel remounts on every visit to the Home tab. Running
    // `claude plugin list` each time to re-derive something the human
    // already told us would be the most expensive read on the panel and
    // the least informative.
    //
    // Settled on failure, like the two reads above: the banner is held
    // back while any input is pending, so a read that threw must still
    // land an answer or the banner never appears again.
    void backend
      .getSuperpowersMarks()
      .catch(() => ({}) as Record<string, SuperpowersMark>)
      .then((marks) => {
        if (mine !== readToken) return;
        const recorded = marks[r];
        superpowersMark = recorded;
        if (recorded) return;
        return backend
          .superpowersStatus(r)
          .catch(() => UNKNOWN_STATUS)
          .then((res) => {
            if (mine !== readToken) return;
            superpowers = res;
          });
      });
    // One-shot git status for the tile — no watcher here; the Git tab
    // itself holds the live one.
    ensureGitView(workspaceId, r);
    void refreshGit(workspaceId);
  });

  const git = $derived($gitStore[workspaceId] ?? null);
  // Null, not [], while the refs snapshot is loading -- unknown must not
  // read as "every worktree is gone" (the tab's own rule).
  const orchestra = $derived(
    orchestrationSummary(
      $orchestrations[workspaceId],
      tree,
      git?.refs?.worktrees ?? null,
      git?.refs?.branches.map((b) => b.name) ?? null
    )
  );
  const orchestrationLine = $derived(
    orchestra.rails.length === 0
      ? "no rails"
      : [
          `${orchestra.rails.length} ${orchestra.rails.length === 1 ? "rail" : "rails"}`,
          orchestra.railsRunning > 0 ? `${orchestra.railsRunning} running` : null,
          orchestra.stepsStalled > 0 ? `${orchestra.stepsStalled} stalled` : null,
          orchestra.conflicts > 0
            ? `${orchestra.conflicts} ${orchestra.conflicts === 1 ? "conflict" : "conflicts"}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
  );
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
    <!-- Not while pending: an unfinished setup and an unfinished read
         look identical from here, and only one of them is worth a
         banner. -->
    {#if root && !setup.pending && !setup.complete}
      <button type="button" class="setup-card" onclick={() => openWizard(workspaceId)}>
        <b>Finish setting up this workspace</b>
        <span>{setup.done.length} of {SETUP_STEPS.length} done — continue</span>
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
        <button type="button" class="panel rail-panel" onclick={() => go("orchestration")}>
          <span class="panel-head">
            Orchestration
            {#if orchestra.conflicts > 0}
              <span class="badge" class:live={orchestra.liveConflicts > 0}>
                ⚠ {orchestra.conflicts}
              </span>
            {/if}
          </span>
          {#if orchestra.rails.length === 0}
            <span class="muted">No rails yet.</span>
          {:else}
            <span class="rails">
              {#each orchestra.rails as r (r.id)}
                <span class="rail">
                  <span class="rail-name">{r.name}</span>
                  <span class="state {r.state}">{r.state}</span>
                  <!-- An armed rail says where it IS; an idle one says how
                       much of it is already behind us. -->
                  <span class="progress">
                    {#if r.currentStage !== null}
                      stage {r.currentStage}/{r.stagesTotal}
                    {:else}
                      {r.stagesDone}/{r.stagesTotal} done
                    {/if}
                  </span>
                  {#if r.stepsStalled > 0}
                    <span class="stalled">{r.stepsStalled} stalled</span>
                  {/if}
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
      <button type="button" class="tile" onclick={() => go("orchestration")}>
        <b>Orchestration</b><span>{orchestrationLine}</span>
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
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  /* Sized to its rails rather than to a third of the column: a workspace
     with two rails should not cost the PRD half its excerpt. Capped so a
     long plan scrolls inside the panel instead of squeezing the others. */
  .rail-panel {
    flex: 0 1 auto;
    max-height: 45%;
  }
  /* Two axes kept apart, as on the tab (spec O9): the count is the fact,
     the colour is only whether any of them is live right now. */
  .badge {
    color: var(--warning-text);
    letter-spacing: normal;
  }
  .badge.live {
    color: var(--danger-text);
  }
  .rails {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-self: stretch;
    min-height: 0;
    overflow-y: auto;
  }
  .rail {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .rail-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The same three tones the rail header's own state chip wears. */
  .state {
    flex: none;
    color: var(--text-subtle);
  }
  .state.running {
    color: var(--accent-text);
  }
  .state.paused {
    color: var(--warning-text);
  }
  .progress {
    flex: none;
    color: var(--text-muted);
  }
  .stalled {
    flex: none;
    color: var(--danger-text);
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
    grid-template-columns: repeat(6, 1fr);
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
  /* Grid items are min-width:auto by default, so six unbreakable labels
     would widen the row past the pane rather than shrink. Let them
     shrink, and ellipsise what no longer fits. */
  .tile,
  .tile b,
  .tile span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
