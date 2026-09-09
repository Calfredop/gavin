<script lang="ts">
  // The app hub: a fleet overview above every workspace. A thin template
  // over appHub.ts (order, ages, links, the fleet tallies),
  // sidebarSummary.ts (the per-row recap and the badge vocabulary) and
  // workspaceCreate.ts (the one creation flow) -- it decides nothing
  // itself, which is what keeps a hub row and the sidebar row for the
  // same workspace from ever disagreeing.
  import { onDestroy, onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    Plus,
    SquareArrowOutUpRight,
    Boxes,
    GitBranch,
    Kanban,
    Route,
    Check,
    MemoryStick,
    PanelsTopLeft,
    SquareTerminal,
    CircleDashed,
    TriangleAlert,
  } from "@lucide/svelte";
  import * as backend from "$lib/backend";
  import {
    layoutState,
    switchWorkspace,
    switchWorkspaceView,
    switchToSessionInPage,
    daemonCompat,
    agentProfilesStore,
    resolvedAgents,
    attentionState,
  } from "$lib/layoutState";
  import { featureBlockedReason } from "$lib/daemonCompat";
  import { workspaceAgentsSummary, kanbanColumnChips, railStripStats, showGitChip } from "$lib/sidebar/sidebarSummary";
  import type { FleetSummary, RunningTask, TaskPhase, WorkspaceRunning } from "$lib/appHub";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import {
    agentIndicator,
    agentIndicatorByState,
    agentInterruptedIndicator,
    attentionIndicator,
    gitIndicator,
    type Indicator,
  } from "$lib/ui/indicators";
  import {
    recentWorkspaces,
    relativeTime,
    appLinks,
    workspaceRecapLine,
    runningTasks,
    fleetSummary,
    sessionsRecap,
    sessionsAttentionLine,
    usageRecap,
    usageRowNote,
    worstUsageRow,
    PHASE_LABEL,
    APP_VERSION,
  } from "$lib/appHub";
  import {
    sessionRows,
    formatCpu,
    formatMemory,
    totalsCoverage,
    totalsNote,
    type ManagedSessions,
    type SessionRow,
  } from "$lib/sessions/sessionsManager";
  import { barPercent, displayPercent, formatResetsIn } from "$lib/agentUsage";
  import { agentUsageStore, nowStore, pausedWorkspaces } from "$lib/agentPauseState";
  import { openAppPanel, showAppPanel } from "$lib/appPanels";
  import {
    newWorkspaceFlow,
    startCreatingWorkspace,
    setNewWorkspaceName,
    commitNewWorkspace,
    cancelNewWorkspace,
  } from "$lib/workspaceCreate";
  import {
    attentionInbox,
    rowTip,
    waitLabel,
    REASON_LABEL,
    type AttentionRow,
  } from "$lib/attentionInbox";
  import { openLinkedCard } from "$lib/cards/cardTabLink";
  import { revealSession } from "$lib/cards/cardRunActions";
  import { kanbanState } from "$lib/board/kanbanState";
  import { fleetStripLine } from "$lib/launchQueue";
  import { gavinTrees } from "$lib/gavinState";
  import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestrationState";
  import { railsWantingAttention } from "$lib/orchestration";
  import { agentCommitPhase, gitStore } from "$lib/gitState";
  import { tooltip } from "$lib/tooltip";
  import { accentVar } from "$lib/settings";
  import { themeState } from "$lib/ui/themeState.svelte";

  /// The row's badge is the board card's badge for the same session --
  /// one agent vocabulary (ui/indicators.ts) rather than the private dot
  /// set this column used to keep. `waiting` is the hub's word for the
  /// daemon's waiting_for_input; the other phases are the agent states
  /// by name.
  function phaseIndicator(phase: TaskPhase): Indicator {
    if (phase === "interrupted") return agentInterruptedIndicator();
    if (phase === "failed") return agentIndicator("failed");
    return agentIndicatorByState(phase === "waiting" ? "waiting_for_input" : phase);
  }

  // Sampled once per render of the hub rather than ticked: the ages here
  // are "2m ago"-coarse, and a timer redrawing the whole list every
  // second to move one of them would cost more than it tells anyone.
  // Reopening the hub re-samples it.
  const now = Date.now();

  const recents = $derived(recentWorkspaces($layoutState.workspaces));
  const links = appLinks();

  let nameInput: HTMLInputElement | null = $state(null);
  // Only the box this surface opened -- the sidebar renders one from the
  // same store, and it is still on screen behind the hub.
  const naming = $derived($newWorkspaceFlow.naming?.surface === "hub" ? $newWorkspaceFlow.naming : null);

  $effect(() => {
    if (naming && nameInput) nameInput.focus();
  });

  const daemonLine = $derived($daemonCompat ? ` · daemon protocol v${$daemonCompat.daemonVersion}` : "");

  // The board and orchestration behind every rooted workspace are
  // already in the stores: the sidebar -- which is on screen beside this
  // -- requests them for its own recap rows. Nothing is fetched here, so
  // opening the hub costs no traffic and the two surfaces can never show
  // different numbers for the same workspace.
  const attention = $derived.by(() => {
    const out: Record<string, ReadonlySet<string>> = {};
    for (const [workspaceId, orch] of Object.entries($orchestrations)) {
      const marks = $stepAttentionsByWorkspace[workspaceId];
      if (marks) out[workspaceId] = railsWantingAttention(orch, marks);
    }
    return out;
  });

  const committing = $derived.by(() => {
    const out = new Set<string>();
    for (const ws of $layoutState.workspaces) {
      const phase = agentCommitPhase($gitStore[ws.id] ?? null);
      if (phase === "starting" || phase === "running") out.add(ws.id);
    }
    return out;
  });

  // `attentionState` rather than `layoutState`: every figure this hub
  // draws is a reason to go and look at something, and a wait the human
  // has already marked as read is not one. Nothing that ACTS on a
  // session reads this view -- see sessionRead.ts.
  const fleet = $derived({
    state: $attentionState,
    boards: $kanbanState,
    trees: $gavinTrees,
    orchestrations: $orchestrations,
    attention,
    committing,
    // The sidebar footer's own strip, passed rather than recomputed: the
    // hub and the footer are on screen together, and two arithmetics for
    // one number is the shape that drifts.
    memory: $fleetStripLine,
  });

  const stats: FleetSummary = $derived(fleetSummary(fleet));
  const running: WorkspaceRunning[] = $derived(runningTasks(fleet));

  // The same stores the fleet reads, plus the rails' raw step marks --
  // `attention` above is those marks already folded down to rail ids,
  // which is what the strip counts and not what a row needs. Nothing new
  // is fetched for either.
  const inbox: AttentionRow[] = $derived(
    attentionInbox(
      {
        state: $attentionState,
        boards: $kanbanState,
        trees: $gavinTrees,
        orchestrations: $orchestrations,
        stepAttentions: $stepAttentionsByWorkspace,
      },
      now
    )
  );

  // ---- what the daemon is holding ------------------------------------
  //
  // The one thing on this surface with a reader of its own: no store
  // keeps the daemon's session list, so the recap has to ask. It runs
  // only while the hub is mounted -- +page.svelte draws it behind
  // `{#if $appHubOpen}`, so leaving the hub stops the sampling -- and at
  // four seconds rather than the task manager's two, because this panel
  // answers "what is the fleet costing" and not "what is it doing this
  // instant".
  const SESSIONS_POLL_MS = 4000;

  let sample = $state<ManagedSessions | null>(null);
  let previousSample = $state<ManagedSessions | null>(null);
  /// Nothing has come back yet. Held apart from an empty list because
  /// "the daemon is holding no sessions" is the one answer this panel
  /// must never give wrongly, and it is exactly what an unfilled list
  /// looks like.
  let sessionsLoaded = $state(false);
  let sessionsError = $state<string | null>(null);
  /// Svelte 5 proxies $state objects, so `sample !== next` can never
  /// decide whether a reply is still wanted. A counter can.
  let sessionsEpoch = 0;
  let sessionsTimer: ReturnType<typeof setInterval> | null = null;

  async function pollSessions(): Promise<void> {
    // The task manager polls at two seconds while it is open, and it is
    // drawn over this. Two walks of the process table for one screen,
    // one of them behind a modal, is what this guard is for.
    if ($openAppPanel === "sessions") return;
    const mine = ++sessionsEpoch;
    let next: ManagedSessions;
    try {
      next = await backend.listManagedSessions();
    } catch (e) {
      if (mine !== sessionsEpoch) return;
      sessionsError = e instanceof Error ? e.message : String(e);
      return;
    }
    if (mine !== sessionsEpoch) return;
    // The CPU rate needs the reading BEFORE this one, so the shift
    // happens here rather than at the top: a failed poll must not become
    // the baseline the next one divides against.
    previousSample = sample;
    sample = next;
    sessionsLoaded = true;
    sessionsError = null;
  }

  onMount(() => {
    void pollSessions();
    sessionsTimer = setInterval(() => void pollSessions(), SESSIONS_POLL_MS);
  });

  onDestroy(() => {
    // The only reason the daemon is walking the process table is that
    // this is on screen, so leaving has to actually stop it.
    sessionsEpoch += 1;
    if (sessionsTimer !== null) clearInterval(sessionsTimer);
  });

  // Through the task manager's own row builder, so a session is named,
  // placed and called stale by exactly one set of rules wherever it is
  // shown. Unsorted here: sessionRows already hands them back
  // attention-first, which is the order the recap wants.
  const managed: SessionRow[] = $derived(
    sample
      ? sessionRows({
          sample,
          previous: previousSample,
          workspaces: $layoutState.workspaces,
          sessionNames: $layoutState.sessionNames,
        })
      : []
  );
  const sessions = $derived(sessionsRecap(managed));
  const sessionsLine = $derived(sessionsAttentionLine(sessions));
  /// The daemon is too old to measure anything. Said in words, because
  /// blank figures would read as "these sessions cost nothing" -- a
  /// measurement nobody took.
  const metricsBlocked = $derived(featureBlockedReason($daemonCompat, "sessionMetrics"));

  // ---- what the agents have left to spend ----------------------------
  //
  // Fetches nothing: startPauseClock already reads every profile the
  // fleet runs, app-wide, whether or not the hub is open.
  const usage = $derived(
    usageRecap({
      profiles: $agentProfilesStore,
      profileByWorkspace: Object.fromEntries(
        $layoutState.workspaces.map((w) => [w.id, $resolvedAgents(w.id).profileId ?? null])
      ),
      reports: $agentUsageStore,
    })
  );
  const worstAgent = $derived(worstUsageRow(usage));

  /// What the heading's badge means, spelled out. The percentage alone
  /// says nothing about WHICH window is nearly full, and the weekly and
  /// the five-hour are different problems.
  function worstAgentTip(): string {
    if (!worstAgent?.worst) return "";
    const resets = formatResetsIn(worstAgent.worst.resetsAt, $nowStore);
    const head = `${worstAgent.label}: ${worstAgent.worst.label} ${displayPercent(worstAgent.worst.usedPercent)}% used`;
    return resets ? `${head}, ${resets}` : head;
  }

  /// Every held workspace, named with its own reason. One line per
  /// workspace because the reasons genuinely differ -- one can be at a
  /// weekly limit while another is inside a scheduled pause.
  function pausedTip(): string {
    return $pausedWorkspaces.map((w) => `${w.name} — ${w.verdict.why ?? "held"}`).join("\n");
  }

  /// What a stale row is, in the sentence sessionsManager.ts already
  /// writes for it, plus where to act on it.
  function staleTip(row: SessionRow): string {
    const where = row.workspaceName ? `${row.workspaceName} · ${row.cwd}` : row.cwd;
    return `${row.note ?? row.state}\n${where}\nOpen the task manager to end it.`;
  }

  function recap(workspaceId: string): string {
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    return ws ? workspaceRecapLine(workspaceAgentsSummary(ws, $attentionState)) : "";
  }

  function accentOf(workspaceId: string): string {
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    return accentVar(ws?.color, themeState.effective) ?? "transparent";
  }

  function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }

  // Spelled out in the tooltips, the way the sidebar's own strip does it:
  // the badges are glyphs and numbers, and the full sentence is a hover
  // away rather than crowded onto the row.
  function workspacesTip(): string {
    const rest = stats.workspaces - stats.rooted;
    const tail = rest > 0 ? `, ${rest} with no folder` : "";
    return `${plural(stats.workspaces, "workspace", "workspaces")}: ${stats.rooted} with a folder${tail}`;
  }

  function agentsTip(): string {
    const buckets: string[] = [];
    if (stats.agents.running > 0) buckets.push(`${stats.agents.running} working`);
    if (stats.agents.waiting > 0) buckets.push(`${stats.agents.waiting} waiting for input`);
    if (stats.agents.idle > 0) buckets.push(`${stats.agents.idle} idle`);
    const agents = stats.agents.agents === 0 ? "no agents" : buckets.join(", ");
    return `${plural(stats.agents.tabs, "tab", "tabs")} across ${plural(stats.agents.pages, "page", "pages")} — ${agents}`;
  }

  function gitTip(): string {
    const parts: string[] = [];
    if (stats.git.committing) parts.push("an agent is committing");
    if (stats.git.repoCount > 0) parts.push(plural(stats.git.repoCount, "repo", "repos"));
    if (stats.git.dirtyCount > 0) parts.push(`${stats.git.dirtyCount} with uncommitted changes`);
    if (stats.git.ahead > 0) parts.push(`${stats.git.ahead} ahead`);
    if (stats.git.behind > 0) parts.push(`${stats.git.behind} behind`);
    return parts.join(", ");
  }

  function cardsTip(): string {
    const detail = stats.cards.columns
      .filter((c) => c.count > 0)
      .map((c) => `${c.name} ${c.count}`)
      .join(", ");
    return `${plural(stats.cards.total, "card", "cards")} across the fleet: ${detail}`;
  }

  function railsTip(): string {
    const parts: string[] = [];
    if (stats.rails.running > 0) parts.push(`${stats.rails.running} running`);
    if (stats.rails.attention > 0) parts.push(`${stats.rails.attention} needing you`);
    if (stats.rails.done > 0) parts.push(`${stats.rails.done} done`);
    if (stats.rails.idle > 0) parts.push(`${stats.rails.idle} idle`);
    return `${plural(stats.rails.total, "rail", "rails")}: ${parts.join(", ")}`;
  }

  function taskTip(task: RunningTask): string {
    const where = task.pageName ? ` on ${task.pageName}` : "";
    const column = task.cardStatus ? ` · ${task.cardStatus}` : "";
    return `${PHASE_LABEL[task.phase]}${where}${column} — open the card`;
  }

  /// The row's own click: the card, in the tab that owns it. Exactly the
  /// jump the tab bar's ↗ and the sidebar's session rows make, so a card
  /// is reached the same way from wherever it is named.
  function openCard(task: RunningTask): void {
    void openLinkedCard(task.workspaceId, task);
  }

  /// The terminal the agent is actually in. Follows the TAB rather than
  /// the card: a tab dragged to another workspace is still the session
  /// this row is about.
  function openTerminal(task: RunningTask): void {
    if (!task.pageId || !task.pageWorkspaceId) return;
    void switchToSessionInPage(task.pageWorkspaceId, task.pageId, task.sessionId);
  }

  /// An inbox row's click: the session that is waiting, in the tab that
  /// holds it. `revealSession` activates the workspace, its page and the
  /// tab in one go -- the same jump the tab bar's ↗ and the sidebar's
  /// session rows make.
  ///
  /// A row with no page is the workspace's own Home agent, which lives
  /// outside every page tree; adopting it onto a page would move it out
  /// of the panel that owns it, so that one lands on the Home tab.
  async function openWaiting(row: AttentionRow): Promise<void> {
    if (row.pageId === null) {
      await switchWorkspace(row.workspaceId);
      await switchWorkspaceView(row.workspaceId, "home");
      return;
    }
    await revealSession(row.sessionId);
  }
</script>

<div class="hub">
  <header>
    <h1>
      <!-- The app icon's own 8-bit prompt glyph, so the hub's masthead
           and the thing in the dock read as one mark. -->
      <span class="mark" aria-hidden="true">&gt;</span>Gavin
    </h1>
    <!-- The daemon's protocol version only once it is known: the hub can
         be on screen before the compat probe answers, and "v0" would be
         a lie rather than a placeholder. -->
    <p class="version">v{APP_VERSION}{daemonLine}</p>
  </header>

  <!-- The whole fleet in one strip, in the sidebar's own badge
       vocabulary: a hairline pill per group, a glyph and a tabular
       number per stat, colour only where it is semantic. Readouts, not
       buttons -- every one of them spans every workspace, so there is no
       single tab a click could honestly go to. -->
  <section class="stats" aria-label="Fleet totals">
    <span class="stat-group" role="group" use:tooltip={workspacesTip()} aria-label={workspacesTip()}>
      <Boxes size={12} />
      <span class="count">{stats.workspaces}</span>
      <span class="stat-label">{stats.workspaces === 1 ? "workspace" : "workspaces"}</span>
    </span>

    <span class="stat-group" role="group" use:tooltip={agentsTip()} aria-label={agentsTip()}>
      <PanelsTopLeft size={12} />
      <span class="count">{stats.agents.tabs}</span>
      <span class="stat-label">tabs</span>
      <!-- The breakdown only where there is one: a fleet with no agent
           in it would otherwise carry a divider and a bare "0", which
           reads as a rendering fault rather than as an empty fleet. -->
      {#if stats.agents.agents > 0}
        <span class="divider" aria-hidden="true"></span>
        <!-- The agent badge from ui/indicators.ts, as the sidebar's own
             strip draws it: these count the very sessions the column
             below lists, and the two must not disagree about what
             "running" looks like. The group has one bubble, so the
             badges take none. -->
        {#if stats.agents.running > 0}
          <StatusBadge indicator={agentIndicatorByState("working")} size={10} tip={null} text={stats.agents.running} />
        {/if}
        {#if stats.agents.waiting > 0}
          <StatusBadge indicator={agentIndicatorByState("waiting_for_input")} size={10} tip={null} text={stats.agents.waiting} />
        {/if}
        {#if stats.agents.failed > 0}
          <StatusBadge indicator={agentIndicatorByState("failed")} size={10} tip={null} text={stats.agents.failed} />
        {/if}
        {#if stats.agents.idle > 0}
          <StatusBadge indicator={agentIndicatorByState("idle")} size={10} tip={null} text={stats.agents.idle} />
        {/if}
      {/if}
    </span>

    <!-- The memory group, beside the agents it is about. Drawn only when
         there is something to say (fleetStrip), so a quiet machine costs
         the strip no width at all. -->
    {#if stats.memory}
      <span
        class="stat-group memory-group tone-{stats.memory.tone}"
        role="group"
        use:tooltip={"Agents running now against the ceiling, and how full this machine is. Set the ceiling in Settings."}
        aria-label={stats.memory.text}
      >
        <MemoryStick size={12} />
        <span class="stat-label">{stats.memory.text}</span>
      </span>
    {/if}

    {#if showGitChip(stats.git)}
      <span class="stat-group" role="group" use:tooltip={gitTip()} aria-label={gitTip()}>
        {#if stats.git.committing}
          <span class="commit-spinner" aria-hidden="true"></span>
        {:else}
          <GitBranch size={12} />
        {/if}
        <span class="count">{stats.git.repoCount}</span>
        <span class="stat-label">{stats.git.repoCount === 1 ? "repo" : "repos"}</span>
        {#if stats.git.dirtyCount > 0}
          <StatusBadge indicator={gitIndicator(true)} size={10} tip={null} />
          <span class="count">{stats.git.dirtyCount}</span>
        {/if}
        {#if stats.git.ahead > 0}<span class="delta">&uarr;{stats.git.ahead}</span>{/if}
        {#if stats.git.behind > 0}<span class="delta">&darr;{stats.git.behind}</span>{/if}
      </span>
    {/if}

    <!-- Spelled out column by column, unlike the 200px sidebar, which
         has room for the total only and expands on hover. Same chips off
         the same fold -- kanbanColumnChips over a summary merged by the
         very slug the tallies were counted by -- so a column's tone here
         and in the sidebar can never disagree. -->
    {#if stats.cards.total > 0}
      <span class="stat-group" role="group" use:tooltip={cardsTip()} aria-label={cardsTip()}>
        <Kanban size={12} />
        <span class="count">{stats.cards.total}</span>
        <span class="stat-label">cards</span>
        <span class="divider" aria-hidden="true"></span>
        {#each kanbanColumnChips(stats.cards) as column}
          <span class="stat card-col {column.tone}">
            <span class="col-initials">{column.initials}</span>
            <span class="count">{column.count}</span>
          </span>
        {/each}
      </span>
    {/if}

    {#if stats.rails.total > 0}
      <span class="stat-group" role="group" use:tooltip={railsTip()} aria-label={railsTip()}>
        <Route size={12} />
        <span class="count">{stats.rails.total}</span>
        <span class="stat-label">{stats.rails.total === 1 ? "rail" : "rails"}</span>
        <span class="divider" aria-hidden="true"></span>
        {#each railStripStats(stats.rails) as key (key)}
          {#if key === "done"}
            <span class="stat done"><Check size={10} /><span class="count">{stats.rails[key]}</span></span>
          {:else}
            <StatusBadge
              indicator={agentIndicatorByState(key === "running" ? "working" : key === "attention" ? "waiting_for_input" : "idle")}
              size={10}
              tip={null}
              text={stats.rails[key]}
            />
          {/if}
        {/each}
      </span>
    {/if}
  </section>

  <div class="columns">
    <!-- What has stopped and is waiting for you, fleet-wide, longest
         wait first. A sibling of the running column and built from the
         same stores; the difference is the question -- that one asks
         what is moving, this one asks what needs you.

         Full width because a row carries six facts. When there is
         nothing in it the panel goes away entirely and leaves one quiet
         line: an empty bordered box is a thing to read, and "nobody is
         waiting" should cost a glance. -->
    {#if inbox.length === 0}
      <p class="inbox-quiet">Nothing is waiting on you.</p>
    {:else}
      <section class="panel inbox">
        <h2>Waiting on you<span class="tally live">{inbox.length}</span></h2>
        <div class="inbox-rows">
          {#each inbox as row (row.sessionId)}
            <button
              type="button"
              class="waiting-row reason-{row.reason}"
              onclick={() => void openWaiting(row)}
              use:tooltip={rowTip(row)}
              aria-label={rowTip(row)}
            >
              <StatusBadge indicator={attentionIndicator(row.reason)} size={11} tip={null} />
              <span class="reason">{REASON_LABEL[row.reason]}</span>
              <span class="where">
                <span class="ws">{row.workspaceName}</span>
                <span class="sep" aria-hidden="true">·</span>
                <span class="page">{row.pageName}</span>
                <span class="sep" aria-hidden="true">·</span>
                <span class="tab">{row.tabName}</span>
              </span>
              <!-- Empty rather than absent for a session nobody filed a
                   card for: the column has to stay in place or every row
                   below it shifts under the pointer. -->
              <span class="card">{row.cardTitle ?? ""}</span>
              <span class="waited" class:bounded={!row.watched}>
                {waitLabel(row.waitedMs, row.watched)}
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <section class="panel recents">
      <h2>Recent workspaces<span class="tally">{stats.workspaces}</span></h2>
      <div class="rows">
        {#each recents as ws (ws.id)}
          <button
            type="button"
            class="row"
            class:current={ws.id === $layoutState.activeWorkspaceId}
            style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
            onclick={() => void switchWorkspace(ws.id)}
          >
            <span class="row-main">
              <span class="name">{ws.name}</span>
              <span class="recap">{recap(ws.id)}</span>
            </span>
            <span class="row-detail">
              <!-- An unrooted workspace says so rather than showing an
                   empty gap: "no folder" is the reason its hub tabs are
                   mostly greyed out, and this is where you notice. -->
              <span class="root">{ws.rootPath ?? "no folder"}</span>
              <span class="age">{relativeTime(ws.lastActiveAt, now)}</span>
            </span>
          </button>
        {/each}
      </div>

      {#if naming}
        <input
          class="new-name"
          aria-label="New workspace name"
          placeholder="Workspace name"
          bind:this={nameInput}
          value={naming.name}
          oninput={(e) => setNewWorkspaceName(e.currentTarget.value)}
          onblur={() => void commitNewWorkspace()}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitNewWorkspace();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelNewWorkspace();
            }
          }}
        />
      {:else}
        <button type="button" class="new" onclick={() => startCreatingWorkspace("hub")}>
          <Plus size={13} />
          New workspace…
        </button>
      {/if}
    </section>

    <!-- Every card with an agent behind it, wherever it is filed. The
         count is fleetSummary's, not a tally of its own, so the strip
         above and this heading are one number. -->
    <section class="panel running">
      <h2>Running tasks<span class="tally" class:live={stats.tasks > 0}>{stats.tasks}</span></h2>
      {#if running.length === 0}
        <p class="empty">
          Nothing is running. Start a card from a workspace's board and it appears here.
        </p>
      {:else}
        <div class="groups">
          {#each running as group (group.workspaceId)}
            <div class="group" style:--row-accent={accentOf(group.workspaceId)}>
              <button
                type="button"
                class="group-head"
                onclick={() => void switchWorkspace(group.workspaceId)}
                use:tooltip={`Switch to ${group.name}`}
              >
                <span class="group-name">{group.name}</span>
                <span class="group-count">{group.tasks.length}</span>
              </button>
              {#each group.tasks as task (task.sessionId)}
                <div class="task" class:waiting={task.phase === "waiting"} class:interrupted={task.phase === "interrupted"}>
                  <button type="button" class="task-main" onclick={() => openCard(task)} use:tooltip={taskTip(task)}>
                    <StatusBadge indicator={phaseIndicator(task.phase)} size={10} tip={null} />
                    <span class="task-text">
                      <span class="task-title">{task.title}</span>
                      <span class="task-meta">
                        <span class="phase {task.phase}">{PHASE_LABEL[task.phase]}</span>
                        {#if task.cardStatus}
                          <span class="sep" aria-hidden="true">·</span>
                          <span class="column">{task.cardStatus}</span>
                        {/if}
                        {#if task.pageName}
                          <span class="sep" aria-hidden="true">·</span>
                          <span class="page">{task.pageName}</span>
                        {/if}
                      </span>
                    </span>
                    {#if task.view === "orchestration"}
                      <span class="on-rail" aria-hidden="true"><Route size={11} /></span>
                    {/if}
                  </button>
                  <!-- The card is what the row is about; the terminal is
                       the other place you might want to be, so it gets
                       its own target rather than a second guess about
                       which one the click meant. -->
                  <button
                    type="button"
                    class="to-terminal"
                    aria-label={`Open the terminal running ${task.title}`}
                    use:tooltip={"Open the terminal"}
                    disabled={!task.pageId}
                    onclick={() => openTerminal(task)}
                  >
                    <SquareTerminal size={12} />
                  </button>
                </div>
              {/each}
              {#if group.looseAgents > 0}
                <!-- Agents nobody filed a card for. Named rather than
                     folded into the count above: they are work in
                     flight, but they are not tasks, and a heading that
                     counted them would not match the rows under it. -->
                <p class="loose">
                  {plural(group.looseAgents, "busy agent", "busy agents")} with no card
                </p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- What the agents the fleet runs have left to spend. One row per
         PROFILE, not per workspace: a limit belongs to the subscription,
         and four workspaces on Claude Code share one window between
         them. Absence is never zero here -- a profile nobody has read
         yet, one that publishes nothing, and one at 0% are three
         different sentences (appHub's usageRowNote). -->
    <section class="panel usage">
      <h2>
        Agent usage
        {#if worstAgent?.worst}
          <!-- The fleet's nearest ceiling, since the heading has room
               for exactly one number. Omitted rather than drawn "ok"
               when nothing has a reading: "gavin cannot see" must never
               render in the colour of "plenty left". -->
          <span
            class="tally usage-{worstAgent.severity}"
            use:tooltip={worstAgentTip()}
            aria-label={worstAgentTip()}>{displayPercent(worstAgent.worst.usedPercent)}%</span
          >
        {/if}
        <button type="button" class="panel-link" onclick={() => showAppPanel("usage")}>
          Details…
        </button>
      </h2>

      {#if usage.length === 0}
        <p class="empty">No workspace is running an agent yet.</p>
      {:else}
        <div class="usage-rows">
          {#each usage as row (row.profileId)}
            {@const note = usageRowNote(row, $nowStore)}
            {@const worst = row.worst}
            <div class="usage-row">
              <span
                class="usage-name"
                use:tooltip={plural(row.workspaces, "workspace", "workspaces") +
                  " running this agent"}>{row.label}</span
              >
              {#if worst && !note}
                <span class="usage-window">{worst.label}</span>
                <div class="track">
                  <!-- The bands are agentUsage.ts's; the colours only
                       name them, exactly as the usage panel draws them. -->
                  <div
                    class="fill {row.severity}"
                    style="width: {barPercent(worst.usedPercent)}%"
                  ></div>
                </div>
                <span class="pct">{displayPercent(worst.usedPercent)}%</span>
                <span class="resets">{formatResetsIn(worst.resetsAt, $nowStore) ?? ""}</span>
              {:else}
                <span class="usage-note">{note}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if $pausedWorkspaces.length > 0}
        <!-- A hold is the one thing on this panel that is not a
             readout: work that would have started has not. Fleet-wide,
             because a workspace on another agent is not held by this
             one being full. -->
        <p class="paused" use:tooltip={pausedTip()} aria-label={pausedTip()}>
          {plural($pausedWorkspaces.length, "workspace", "workspaces")} paused
        </p>
      {/if}
    </section>

    <!-- Every session the daemon is holding, whether or not a tab is
         showing it -- the task manager's list, folded to a recap. The
         rows here name what is stale; ending one is the panel's job, so
         nothing on the home screen kills a process. -->
    <section class="panel sessions">
      <h2>
        Sessions
        <span class="tally" class:stale={sessions.stale > 0}>{sessions.sessions}</span>
        <button type="button" class="panel-link" onclick={() => showAppPanel("sessions")}>
          Task manager…
        </button>
      </h2>

      <!-- The failure is a line ABOVE the figures, never in place of
           them, exactly as the task manager reports its own: a poll that
           failed does not unmake the last one that worked, and blanking
           the recap would lose the numbers it is still honest about. -->
      {#if sessionsError}
        <p class="session-line">Couldn’t read the session list: {sessionsError}</p>
      {/if}

      {#if !sessionsLoaded}
        {#if !sessionsError}
          <p class="empty">Reading what the daemon is holding…</p>
        {/if}
      {:else if sessions.sessions === 0}
        <p class="empty">The daemon is holding no sessions.</p>
      {:else}
        <div class="cost">
          {#if metricsBlocked}
            <span class="coverage">{metricsBlocked}</span>
          {:else}
            <!-- The task manager's own sums over the task manager's own
                 rows, so the hub and the panel it opens can never state
                 different totals for one daemon. -->
            <span class="figure" use:tooltip={totalsNote(sessions.totals)}>
              CPU <span class="count">{formatCpu(sessions.totals.cpuPercent)}</span>
            </span>
            <span class="figure" use:tooltip={totalsNote(sessions.totals)}>
              MEM <span class="count">{formatMemory(sessions.totals.memBytes)}</span>
            </span>
          {/if}
          <span class="coverage">{totalsCoverage(sessions.totals)}</span>
        </div>

        {#if sessionsLine}
          <p class="session-line">{sessionsLine}</p>
        {/if}

        {#each sessions.attention as row (row.id)}
          <button
            type="button"
            class="stale-row"
            class:survivor={row.staleness === "orphaned"}
            use:tooltip={staleTip(row)}
            aria-label={staleTip(row)}
            onclick={() => showAppPanel("sessions")}
          >
            <!-- The task manager's own marks: a triangle for the one
                 case with a live process nobody is hosting, a hollow
                 ring for a row whose run is over. -->
            {#if row.staleness === "orphaned"}
              <TriangleAlert size={11} />
            {:else}
              <CircleDashed size={11} />
            {/if}
            <span class="stale-state">{row.state}</span>
            <span class="stale-name">{row.label}</span>
            <span class="stale-where">{row.workspaceName ?? "no workspace"}</span>
          </button>
        {/each}
        {#if sessions.more > 0}
          <p class="session-line">+{sessions.more} more stale</p>
        {/if}
      {/if}
    </section>
  </div>

  <footer>
    <!-- appLinks() has already dropped every entry without a url --
         that is how the website row stays out until there is a site to
         point it at -- and the guard below is what proves it to the
         type checker rather than a second policy. -->
    {#each links as link (link.id)}
      {@const url = link.url}
      {#if url}
        <button type="button" class="link" onclick={() => void openUrl(url)}>
          {link.label}
          <SquareArrowOutUpRight size={11} />
        </button>
      {/if}
    {/each}
  </footer>
</div>

<style>
  .hub {
    height: 100%;
    min-height: 0;
    /* The COLUMNS scroll, not the page: two panels that each keep their
       heading in view read as a dashboard, where one long page that
       scrolls both away reads as a document. The narrow layout below
       gives the page its scroll back, because two stacked panels sharing
       one short height would leave neither usable. */
    overflow: hidden;
    box-sizing: border-box;
    padding: 28px 24px 16px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    font-family: monospace;
    color: var(--text);
  }
  header {
    flex: 0 0 auto;
  }
  h1 {
    margin: 0;
    font-size: 1.55em;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  /* Accented and set back from the name, so the mark reads as the
     prompt the app icon draws rather than as part of the word. */
  .mark {
    color: var(--accent);
    margin-right: 6px;
    opacity: 0.9;
  }
  .version {
    margin: 3px 0 0;
    color: var(--text-subtle);
    font-size: 0.78em;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 10px;
    padding-bottom: 8px;
    /* A rule under the heading, the idiom the Kanban and Orchestration
       tabs' own first rows already use. */
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 0.7em;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  /* The section's own number, in the heading rather than beside the
     content: it says how big the list below is before you read it. */
  .tally {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-muted);
    font-size: 0.95em;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  /* Only when something IS running -- a live accent on a zero would be
     the loudest thing on a quiet hub. */
  .tally.live {
    border-color: var(--border-accent);
    color: var(--accent-text);
  }

  /* --- the fleet strip --- */
  .stats {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .stat-group {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-sunken);
    white-space: nowrap;
  }
  /* Colour only when the machine is saying something -- the same three
     tokens IndicatorTone maps to, so this group and a badge beside it
     are the same amber. */
  .memory-group.tone-warning {
    color: var(--warning-text);
    border-color: var(--warning-text);
  }
  .memory-group.tone-danger {
    color: var(--danger-text);
    border-color: var(--danger-text);
  }
  /* The hub has width the sidebar does not, so a group can say what its
     leading number counts instead of leaving the glyph to carry it. */
  .stat-label {
    color: var(--text-subtle);
  }
  .stat {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  /* Separates a group's headline number from the breakdown after it, so
     a run of digits does not read as one number. */
  .divider {
    width: 1px;
    align-self: stretch;
    margin: 1px 2px;
    background: var(--border);
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .delta {
    font-size: 0.9em;
    white-space: nowrap;
  }
  /* The very tones the sidebar's strip uses, for the same reasons: idle
     stays the row's muted default, because "not doing anything" is the
     absence of news. */
  .stat.running,
  .card-col.progress {
    color: var(--accent-text);
  }
  .stat.done,
  .card-col.done {
    color: var(--success-text);
  }
  .stat.attention {
    color: var(--warning-text);
  }
  .col-initials {
    opacity: 0.65;
    margin-right: 2px;
  }
  /* Takes the branch glyph's place rather than sitting beside it, so the
     group keeps its width while a run is in flight. */
  .commit-spinner {
    width: 10px;
    height: 10px;
    flex: 0 0 auto;
    margin: 1px;
    border: 2px solid var(--border-accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: hub-spin 0.8s linear infinite;
  }
  @keyframes hub-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* --- the two columns --- */
  .columns {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    /* minmax(0, …) on both, or a long root path in the left column
       stretches the track instead of ellipsing inside it. */
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    /* The inbox takes only the height its rows need, the two lists under
       it take the rest, and the two recaps at the foot take only theirs.
       An `auto auto` pair would have the grid hand the inbox half the
       hub for two rows; three `auto`s would do the same to the recaps. */
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 16px;
    align-items: stretch;
  }
  /* Full width: an inbox row carries six facts, and a third of the hub
     is not enough for any of them. */
  .inbox,
  .inbox-quiet {
    grid-column: 1 / -1;
  }
  /* The empty state. One line, no border, no heading -- the same
     register as a page's own "nothing here" note rather than a card
     announcing that it has nothing to say. */
  .inbox-quiet {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.82em;
  }
  .inbox {
    /* Never taller than a third of the hub: the recents and running
       columns underneath must stay reachable however long the queue
       gets, and the rows scroll inside instead. */
    max-height: 34vh;
  }
  .inbox-rows {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .waiting-row {
    display: grid;
    /* Column tracks rather than a flex row, so the reason, the location
       and the card line up down the list and the eye can run one column
       instead of re-parsing every row. Every text track is minmax(0, …)
       so a long name ellipses inside its own cell. */
    grid-template-columns: auto minmax(0, 0.85fr) minmax(0, 1fr) minmax(0, 1.15fr) auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    border: 0;
    border-radius: 5px;
    /* The tone lives on the badge, not on the row: a list where every
       row is amber says nothing, and the glyph is what carries which of
       the three reasons this is. */
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.82em;
    text-align: left;
    cursor: pointer;
  }
  .waiting-row:hover {
    background: var(--surface-raised);
  }
  .waiting-row:focus-visible {
    outline: 1px solid var(--border-accent);
    outline-offset: -1px;
  }
  .waiting-row .reason,
  .waiting-row .where,
  .waiting-row .card {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .waiting-row .where,
  .waiting-row .card {
    color: var(--text-muted);
  }
  .waiting-row .tab {
    color: var(--text);
  }
  .waiting-row .sep {
    margin: 0 4px;
    color: var(--text-subtle);
  }
  /* Only the broken rows get colour of their own. `asking` and
     `turn-ended` are ordinary waits and read in the body colour; a
     failure is the one row in the list that is not merely patient. */
  .waiting-row.reason-failed .reason {
    color: var(--danger-text);
  }
  .waited {
    justify-self: end;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  /* A wait gavin did not watch begin. Quieter than a measured one, and
     the "≥" it carries is spelled out in the row's own bubble. */
  .waited.bounded {
    color: var(--text-subtle);
  }
  /* One column under a narrow window, and the page scrolls again. The
     hub shares the width with the sidebar, so this fires earlier than
     the number suggests. */
  @media (max-width: 900px) {
    .hub {
      overflow-y: auto;
    }
    .columns {
      grid-template-columns: minmax(0, 1fr);
      /* Back to implicit auto rows: stacked, the inbox is the first of
         three panels rather than a band across the top, and the wide
         layout's `auto minmax(0, 1fr)` would squash the second one. */
      grid-template-rows: none;
      align-items: start;
    }
    /* Stacked, nothing is competing for the height any more, so every
       panel says what it has to say in full and the page scrolls. The
       two recaps need naming as well as .panel: their own cap is
       declared later in the file, so equal specificity would let it
       win here. */
    .panel,
    .usage,
    .sessions {
      max-height: none;
      overflow-y: visible;
    }
  }
  .panel {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: 12px 12px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    /* The hairline is the whole panel: the app's own ground is
       --surface-base, so a fill of it would be a no-op that stops being
       one the day the ground changes. The rows inside recess instead. */
    background: transparent;
  }
  .rows {
    /* Shrinks and scrolls when the fleet is long, but never GROWS: the
       create button belongs under the last workspace, not stranded at
       the foot of a mostly empty panel. */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* The rows carry their own accent stripe on the left; a scrollbar
       gutter on the right keeps them from jumping when one appears. */
    scrollbar-gutter: stable;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: stretch;
    text-align: left;
    /* The accent stripe the sidebar row for this workspace also carries,
       so the two lists read as the same fleet. */
    border: 1px solid var(--border);
    border-left: 3px solid var(--row-accent);
    border-radius: 6px;
    background: var(--surface-sunken);
    color: var(--text);
    padding: 8px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.82em;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.current {
    border-color: var(--border-strong);
    border-left-color: var(--row-accent);
  }
  .row-main,
  .row-detail {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recap,
  .age {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .root {
    color: var(--text-subtle);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new,
  .new-name {
    margin-top: 8px;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    color: var(--text-muted);
    padding: 8px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.82em;
  }
  .new:hover {
    color: var(--text);
    background: var(--surface-hover);
  }
  .new-name {
    border-style: solid;
    border-color: var(--border-focus);
    background: var(--surface-sunken);
    color: var(--text);
    cursor: text;
  }
  .new-name:focus {
    outline: none;
  }

  /* --- running tasks --- */
  .empty {
    margin: 0;
    padding: 10px 2px;
    color: var(--text-subtle);
    font-size: 0.8em;
    line-height: 1.5;
  }
  .groups {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scrollbar-gutter: stable;
  }
  /* The workspace's accent, as a rule down the left of its whole group
     rather than on each row: the group is the workspace, the rows are
     its cards. */
  .group {
    border-left: 2px solid var(--row-accent);
    padding-left: 8px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0 0 5px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.72em;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    text-align: left;
  }
  .group-head:hover {
    color: var(--text);
  }
  .group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-count {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }
  .task {
    display: flex;
    align-items: stretch;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-sunken);
    margin-bottom: 4px;
  }
  .task:hover {
    border-color: var(--border-strong);
  }
  /* A card that stopped for a human is the one thing on this column
     worth an edge of its own -- in its own dot's tone, so the ring and
     the row can never say different things about the same agent. */
  .task.waiting {
    border-color: var(--border-danger);
  }
  .task.interrupted {
    border-color: var(--border-warning);
  }
  .task-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 4px 7px 9px;
    background: none;
    border: none;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.82em;
    text-align: left;
  }
  .task-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .task-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-meta {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    color: var(--text-subtle);
    font-size: 0.88em;
  }
  /* The phase is the answer and keeps its width; the column and the page
     are context and give theirs up first. min-width:0 because a flex
     item will not ellipse without it. */
  .phase {
    flex: 0 0 auto;
  }
  .column,
  .page {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The same four phases the dot draws, worded. Only the two that want a
     human are coloured -- working is background information, and idle is
     the absence of news. */
  .phase.waiting {
    color: var(--danger-text);
  }
  .phase.interrupted {
    color: var(--warning-text);
  }
  .sep {
    flex: 0 0 auto;
    color: var(--border-strong);
  }
  /* Which rail carries this card, in the same Route glyph the board's
     own cards use for it. */
  .on-rail {
    flex: 0 0 auto;
    display: flex;
    color: var(--text-subtle);
  }
  .to-terminal {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    padding: 0 9px;
    background: none;
    border: none;
    border-left: 1px solid var(--border);
    color: var(--text-subtle);
    cursor: pointer;
  }
  .to-terminal:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-hover);
  }
  .to-terminal:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .loose {
    margin: 6px 0 2px;
    color: var(--text-subtle);
    font-size: 0.75em;
  }

  /* --- agent usage and sessions --- */
  /* The panel's own action, at the end of its heading: the recap says
     what there is, the panel it opens is where anything is done about
     it. Sits in the heading rather than under the rows so it stays put
     while the list under it changes. */
  .panel-link {
    margin-left: auto;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 1em;
    letter-spacing: inherit;
    text-transform: none;
  }
  .panel-link:hover {
    color: var(--text);
  }
  /* Both recaps are read at a glance and never scrolled to: they take
     the height of their content and cap it, rather than stretching to a
     track the way the two lists above them do. */
  .usage,
  .sessions {
    flex: 0 0 auto;
    max-height: 32vh;
    overflow-y: auto;
  }
  .usage-rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8em;
  }
  .usage-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  /* The agent's name keeps its width so the bars line up down the list;
     everything after it gives way first. */
  .usage-name {
    flex: 0 0 auto;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .usage-window {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .track {
    flex: 1 1 auto;
    min-width: 40px;
    height: 5px;
    background: var(--surface-sunken);
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  .fill.warn {
    background: var(--warning);
  }
  .fill.critical {
    background: var(--danger);
  }
  .pct {
    flex: 0 0 auto;
    min-width: 34px;
    text-align: right;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .resets {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
  }
  /* A sentence where a bar would be: no probe, no reading yet, or a
     reading that carried no windows. Wraps, because every one of them is
     a sentence rather than a figure. */
  .usage-note {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-subtle);
  }
  /* The heading badge takes the bands' own tones -- the same three the
     bars use, so the number at the top and the bar it came from can
     never disagree. `ok` is left in the tally's default: a full window
     is news, a half-empty one is not. */
  .tally.usage-warn {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .tally.usage-critical {
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  /* Stale rows are the reason to open the panel, so the count says so.
     Not `.live`, which is the accent every other tally uses for work in
     flight -- a row whose run is over is the opposite of that. */
  .tally.stale {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .paused {
    margin: 8px 0 0;
    color: var(--warning-text);
    font-size: 0.78em;
  }
  /* The two sums and what they cover, on one line: the figures lead
     because they are why anyone looks, and the coverage behind them says
     how many things went into each. */
  .cost {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .figure .count {
    color: var(--text);
  }
  .coverage {
    color: var(--text-subtle);
    font-size: 0.92em;
  }
  .session-line {
    margin: 6px 0 0;
    color: var(--text-subtle);
    font-size: 0.78em;
  }
  /* One stale session. A button because it goes somewhere -- the task
     manager, which is where a row can be ended -- and never because it
     ends anything itself. */
  .stale-row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    box-sizing: border-box;
    margin-top: 5px;
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface-sunken);
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.78em;
    text-align: left;
  }
  .stale-row:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  /* The one kind with a live process nobody is hosting. The only row
     here that earns an edge of its own. */
  .stale-row.survivor {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .stale-state {
    flex: 0 0 auto;
  }
  .stale-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .stale-where {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
  }

  footer {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .link {
    display: flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    padding: 0;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.78em;
  }
  .link:hover {
    color: var(--text);
  }
</style>
