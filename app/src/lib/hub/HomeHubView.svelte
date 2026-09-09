<script lang="ts">
  import { onMount } from "svelte";
  import {
    layoutState,
    switchWorkspaceView,
    agentProfilesStore,
    openWizard,
    agentModelDefaultsStore,
    setHomeAgentShare,
    trustedAgentConfigs,
  } from "$lib/layoutState";
  import { resolveAgentConfig, resolvePrdPath } from "$lib/settings";
  import { setupProgress, SETUP_STEPS } from "$lib/setupWizard";
  import { UNKNOWN_STATUS, type SuperpowersMark, type SuperpowersStatus } from "$lib/superpowers";
  import { gavinTrees, refreshGavinTree } from "$lib/gavinState";
  import { fetchBoard, kanbanState } from "$lib/board/kanbanState";
  import { boardSummary, planSummary, prdExcerpt, orchestrationSummary } from "$lib/hub/homeSummary";
  import MainAgentPanel from "$lib/hub/MainAgentPanel.svelte";
  import ConfigTrustNotice from "$lib/ConfigTrustNotice.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { railIndicator } from "$lib/ui/indicators";
  import * as backend from "$lib/backend";
  import { gitStore, ensureGitView, refresh as refreshGit } from "$lib/gitState";
  import { changedCount } from "$lib/git";
  import { orchestrations, fetchOrchestration } from "$lib/orchestrationState";
  import {
    DEFAULT_AGENT_SHARE,
    agentShareFromWidth,
    homeGridColumns,
    resolveAgentShare,
  } from "$lib/hub/homeSplit";
  import { tooltip } from "$lib/tooltip";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  // The panel scrolls, so this is not "what fits" but "how much of the
  // PRD is worth keeping in a summary tile". Long enough that scrolling
  // it answers a question; short enough that a book-length PRD does not
  // land in the home tab whole -- the PRD tab is where it is read.
  const EXCERPT_LINES = 200;

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
      $trustedAgentConfigs(workspaceId),
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
  let agentEl = $state<HTMLElement | null>(null);
  let dragging = $state(false);

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
      configCommand: $trustedAgentConfigs(workspaceId)?.command ?? null,
      agentFileBody,
      prdBody,
      mainSessionId: ws?.mainSessionId ?? null,
      superpowers,
      superpowersMark,
      // Read off the workspace record rather than from git: the step's
      // evidence is a recorded answer, so the banner needs no extra round
      // trip on every visit to this tab -- and `git` is outside
      // `configured` anyway, which is what this banner reads.
      gitTrackingAsked: Boolean(ws?.gitTrackingAsked),
      // Same shape, same reason -- see the git field above.
      requireReviewAsked: Boolean(ws?.requireReviewAsked),
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
          .superpowersStatus(r, agentCfg.command)
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

  // The agent's own cell, not the row: dragging the divider leaves the
  // row exactly as wide as it was, and a terminal that only refits when
  // the WINDOW changes size would keep the columns it had before the
  // drag.
  onMount(() => {
    if (!agentEl) return;
    const observer = new ResizeObserver(() => agent?.fit());
    observer.observe(agentEl);
    return () => observer.disconnect();
  });

  // The divider between the agent and the summaries column. What is kept
  // is the agent cell's SHARE of the row, applied as the grid's two `fr`
  // factors, so the split holds at every pane width -- see homeSplit.ts.
  const storedShare = $derived(resolveAgentShare(ws?.homeAgentShare));
  let share = $state(DEFAULT_AGENT_SHARE);
  $effect(() => {
    share = storedShare;
  });

  // Window-level listeners with a buttons===0 bail-out, like every other
  // splitter here: WKWebView drops pointerup when the pointerdown target
  // leaves the DOM.
  function startDrag(e: PointerEvent): void {
    e.preventDefault();
    // The divider's own neighbours are the two cells it divides.
    const el = e.currentTarget as HTMLElement | null;
    const left = el?.previousElementSibling as HTMLElement | null;
    const right = el?.nextElementSibling as HTMLElement | null;
    if (!left || !right) return;
    const startX = e.clientX;
    const startW = left.offsetWidth;
    const total = startW + right.offsetWidth;
    const startShare = share;
    dragging = true;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) {
        up();
        return;
      }
      share = agentShareFromWidth(startW + ev.clientX - startX, total);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      dragging = false;
      // A click that never moved writes nothing -- which also keeps the
      // two clicks of a double-click from racing the reset below.
      if (share !== startShare) void setHomeAgentShare(workspaceId, share);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // Double-click restores the split the tab ships with -- the way back
  // from a divider dragged somewhere unhelpful. Clears the preference
  // rather than storing the default, so absence keeps meaning "never
  // dragged".
  function resetSplit(): void {
    share = DEFAULT_AGENT_SHARE;
    void setHomeAgentShare(workspaceId, undefined);
  }

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
         banner. And `configured`, not `complete`: launch is optional and
         its evidence is a live session, so keyed off `complete` this
         banner reappeared the moment the agent panel's Stop was pressed
         (design §5.4 -- an unlaunched workspace does not nag). -->
    {#if root && !setup.pending && !setup.configured}
      <button type="button" class="setup-card" onclick={() => openWizard(workspaceId)}>
        <b>Finish setting up this workspace</b>
        <span>{setup.done.length} of {SETUP_STEPS.length} done — continue</span>
      </button>
    {/if}
    <!-- Home is where the workspace's own agent launches, and it is the
         tab a freshly cloned repo opens on. If its config.toml names a
         command gavin is refusing to run, this is the first place that
         has to say so. -->
    <ConfigTrustNotice {workspaceId} />
    <div class="grid" style:grid-template-columns={homeGridColumns(share)}>
      <div class="agent-cell" bind:this={agentEl}>
        <MainAgentPanel bind:this={agent} {workspaceId} />
      </div>
      <div
        class="divider"
        class:dragging
        role="separator"
        aria-orientation="vertical"
        use:tooltip={"Drag to resize \u00b7 double-click to reset"}
        onpointerdown={startDrag}
        ondblclick={resetSplit}
      ></div>
      <div class="side">
        <button type="button" class="panel" onclick={() => go("prd")}>
          <span class="panel-head">PRD</span>
          {#if prdLines.length === 0}
            <span class="muted">No PRD yet.</span>
          {:else}
            <span class="excerpt">{prdLines.join("\n")}</span>
          {/if}
        </button>
        <button type="button" class="panel board-panel" onclick={() => go("kanban")}>
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
                  <StatusBadge indicator={railIndicator(r.state)} text={r.state} />
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
  /* Columns come from homeSplit's template, inline: the divider between
     them IS the gutter the grid used to hold, so there is no column gap
     of its own to add. */
  .grid {
    display: grid;
    flex: 1 1 auto;
    min-height: 0;
  }
  .agent-cell {
    min-width: 0;
    min-height: 0;
  }
  /* The grab area is the whole track; only the hairline down its middle
     ever paints, so an idle home tab looks exactly as it did before the
     divider became draggable. */
  .divider {
    position: relative;
    cursor: col-resize;
  }
  .divider::before {
    content: "";
    position: absolute;
    inset: 0 4px;
    border-radius: 2px;
    background: transparent;
  }
  .divider:hover::before,
  .divider.dragging::before {
    background: var(--border-strong);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
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
  .progress {
    flex: none;
    color: var(--text-muted);
  }
  .stalled {
    flex: none;
    color: var(--danger-text);
  }
  /* Scrolls rather than clips: the panel is as tall as the column
     leaves it, and an excerpt cut off mid-sentence with no way to see
     the rest is the one thing a PRD summary must not be. Stretched and
     min-height:0 for the same reason the rails list is -- a flex child
     only scrolls once it is allowed to be shorter than its content. */
  .excerpt {
    align-self: stretch;
    white-space: pre-wrap;
    min-height: 0;
    overflow-y: auto;
    opacity: 0.85;
    line-height: 1.5;
  }
  .muted {
    color: var(--text-subtle);
  }
  /* Sized to its chips rather than to a third of the column: a board is
     one wrapped row of counts, and spending a third of the side column
     on it is a third the PRD excerpt does not get. Capped so a board
     with many columns scrolls instead of squeezing the others. */
  .board-panel {
    flex: 0 1 auto;
    max-height: 30%;
  }
  .columns {
    display: flex;
    flex-wrap: wrap;
    align-self: stretch;
    gap: 8px;
    min-height: 0;
    overflow-y: auto;
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
