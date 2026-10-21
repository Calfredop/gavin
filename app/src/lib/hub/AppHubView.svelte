<script lang="ts">
  // The app hub: a fleet overview above every workspace, in three columns
  // -- the workspaces, one feed of what needs you and what is moving, and
  // the gauges -- under the live app icon. A thin template
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
  import * as backend from "$lib/core/backend";
  import {
    layoutState,
    switchWorkspace,
    switchToSessionInPage,
    daemonCompat,
    agentProfilesStore,
    resolvedAgents,
    attentionState,
  } from "$lib/core/layoutState";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import { turnVerdictById, verdictsOf } from "$lib/agents/turnVerdictState";
  import { workspaceAgentsSummary, kanbanColumnChips, railStripStats, showGitChip } from "$lib/sidebar/sidebarSummary";
  import type { FleetSummary, RunningTask, TaskPhase, WorkspaceRunning } from "$lib/hub/appHub";
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
  } from "$lib/hub/appHub";
  import {
    sessionRows,
    formatCpu,
    formatMemory,
    totalsCoverage,
    totalsNote,
    type ManagedSessions,
    type SessionRow,
  } from "$lib/sessions/sessionsManager";
  import { barPercent, displayPercent, formatResetsIn } from "$lib/agents/agentUsage";
  import { agentUsageStore, nowStore, pausedWorkspaces } from "$lib/agents/agentPauseState";
  import {
    savingsByProfile,
    savingsSince,
    windowSavingsLine,
    windowSavingsTip,
  } from "$lib/agents/headroomSavings";
  import { headroomSavingsStore, loadHeadroomSavings } from "$lib/agents/headroomSavingsState";
  import { openAppPanel, showAppPanel } from "$lib/panes/appPanels";
  import {
    newWorkspaceFlow,
    startCreatingWorkspace,
    setNewWorkspaceName,
    commitNewWorkspace,
    cancelNewWorkspace,
  } from "$lib/workspace/workspaceCreate";
  import {
    attentionInbox,
    rowTip,
    waitLabel,
    REASON_LABEL,
    type AttentionRow,
  } from "$lib/agents/attentionInbox";
  import { openLinkedCard } from "$lib/cards/cardTabLink";
  import { revealWaitingSession } from "$lib/cards/cardRunActions";
  import { kanbanState } from "$lib/board/kanbanState";
  import { fleetStripLine } from "$lib/agents/launchQueue";
  import { gavinTrees } from "$lib/core/gavinState";
  import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestration/orchestrationState";
  import { railsWantingAttention } from "$lib/orchestration/orchestration";
  import { agentCommitPhase, gitStore } from "$lib/git/gitState";
  import { tooltip } from "$lib/core/tooltip";
  import { accentVar } from "$lib/core/settings";
  import { themeState } from "$lib/ui/themeState.svelte";
  import LiveAppIcon from "$lib/ui/LiveAppIcon.svelte";
  import { fleetIconStatus } from "$lib/ui/appIconMotion";
  import ActivityCalendar from "$lib/activity/ActivityCalendar.svelte";
  import { openRunCard, openToolsTab } from "$lib/activity/activityNav";

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

  /// Cards with an agent behind them, per workspace, for the rail's count.
  const runningIn = $derived(Object.fromEntries(running.map((g) => [g.workspaceId, g.tasks.length])));

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
        // The turn verdicts, so a prose question -- no bell, `idle` to
        // the daemon -- lists the way a `waiting_for_input` one does.
        verdicts: verdictsOf($turnVerdictById),
      },
      now
    )
  );

  /// Sessions the feed already lists as a wait, so the task rows under
  /// them do not list the same agent twice.
  const waitingIds = $derived(new Set(inbox.map((row) => row.sessionId)));

  /// What the masthead's live icon shows, from the very figures drawn
  /// beside it.
  const iconStatus = $derived(
    fleetIconStatus({
      running: stats.agents.running,
      failed: stats.agents.failed,
      inbox: inbox.length,
      paused: $pausedWorkspaces.length,
    })
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
  const profileByWorkspace = $derived(
    Object.fromEntries($layoutState.workspaces.map((w) => [w.id, $resolvedAgents(w.id).profileId ?? null]))
  );
  const usage = $derived(
    usageRecap({
      profiles: $agentProfilesStore,
      profileByWorkspace,
      reports: $agentUsageStore,
    })
  );
  const worstAgent = $derived(worstUsageRow(usage));

  // ---- what Headroom saved in each window ----------------------------
  //
  // The daemon's snapshots, summed into the window each usage row shows
  // (headroomSavings.ts). Asked only while the hub is on screen, like the
  // session recap, and back to the earliest window any row shows. A
  // minute apart: a snapshot lands when a run ENDS, so nothing here moves
  // faster than runs finish.
  const SAVINGS_POLL_MS = 60_000;
  const savingsFrom = $derived(savingsSince(usage.map((row) => row.worst)));
  const savedByProfile = $derived(savingsByProfile(usage, profileByWorkspace, $headroomSavingsStore));
  let savingsTimer: ReturnType<typeof setInterval> | null = null;

  // Re-asked whenever the reach changes -- a window reset, or the first
  // usage reading arriving -- or the daemon's version becomes known, as
  // well as on the timer.
  $effect(() => {
    void loadHeadroomSavings($daemonCompat, savingsFrom);
  });

  onMount(() => {
    savingsTimer = setInterval(() => void loadHeadroomSavings($daemonCompat, savingsFrom), SAVINGS_POLL_MS);
  });

  onDestroy(() => {
    if (savingsTimer !== null) clearInterval(savingsTimer);
  });

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
</script>

<div class="hub">
  <header>
    <!-- The app icon itself, live: its wall moves with the figures this
         hub draws (appIconMotion.ts), so the masthead and the thing in the
         Dock read as one mark that also says how the fleet is. -->
    <LiveAppIcon status={iconStatus} size={64} />
    <div class="masthead">
      <h1>Gavin</h1>
      <!-- The daemon's protocol version only once it is known: the hub can
           be on screen before the compat probe answers, and "v0" would be
           a lie rather than a placeholder. -->
      <p class="version">v{APP_VERSION}{daemonLine}</p>
    </div>
    <!-- appLinks() has already dropped every entry without a url -- that
         is how the website row stays out until there is a site to point it
         at -- and the guard below is what proves it to the type checker
         rather than a second policy. -->
    <nav class="links" aria-label="Gavin links">
      {#each links as link (link.id)}
        {@const url = link.url}
        {#if url}
          <button type="button" class="link" onclick={() => void openUrl(url)}>
            {link.label}
            <SquareArrowOutUpRight size={11} />
          </button>
        {/if}
      {/each}
    </nav>
  </header>

  <!-- Three columns that scroll on their own: where you can go, what is
       happening now, and what it all costs. -->
  <div class="columns">
    <nav class="column rail" aria-label="Workspaces">
      <h2>Workspaces<span class="tally">{stats.workspaces}</span></h2>
      <div class="rows">
        {#each recents as ws (ws.id)}
          {@const busy = runningIn[ws.id] ?? 0}
          <!-- Each its own box, with the accent stripe the sidebar row for
               the same workspace carries, so the two lists read as one
               fleet. A workspace with no colour gets a neutral stripe, so
               every box still has its edge. -->
          <button
            type="button"
            class="row"
            class:current={ws.id === $layoutState.activeWorkspaceId}
            style:--row-accent={accentVar(ws.color, themeState.effective) ?? "var(--border-strong)"}
            onclick={() => void switchWorkspace(ws.id)}
          >
            <span class="row-main">
              <span class="name">{ws.name}</span>
              {#if busy > 0}
                <span class="busy" use:tooltip={plural(busy, "card", "cards") + " with an agent behind it"}>{busy}</span>
              {/if}
            </span>
            {#if recap(ws.id)}
              <span class="recap">{recap(ws.id)}</span>
            {/if}
            <span class="row-detail">
              <!-- An unrooted workspace says so rather than showing an
                   empty gap: "no folder" is the reason its hub tabs are
                   mostly greyed out, and this is where you notice. -->
              <span class="root">{ws.rootPath ?? "no folder"}</span>
              <span class="age">{relativeTime(ws.lastActiveAt, now)}</span>
            </span>
          </button>
        {/each}

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
      </div>
    </nav>

    <!-- One feed of what needs you and what is moving, in that order:
         every wait fleet-wide, longest first, then every card with an
         agent behind it. A session already listed as a wait is not listed
         again as a task. -->
    <section class="column now" aria-label="Now">
      <h2>Now</h2>
      {#if inbox.length === 0 && running.length === 0}
        <p class="empty">
          Nothing is running and nothing is waiting on you. Start a card from a workspace's board and it appears here.
        </p>
      {:else}
        <div class="feed">
          {#each inbox as row (row.sessionId)}
            <button
              type="button"
              class="item waiting-row reason-{row.reason}"
              onclick={() => void revealWaitingSession(row)}
              use:tooltip={rowTip(row)}
              aria-label={rowTip(row)}
            >
              <StatusBadge indicator={attentionIndicator(row.reason)} size={12} tip={null} />
              <span class="item-text">
                <!-- The card when there is one, else the tab: whichever
                     name the human would look for. -->
                <span class="item-title">{row.cardTitle ?? row.tabName}</span>
                <span class="item-meta">
                  <span class="reason">{REASON_LABEL[row.reason]}</span>
                  <span class="sep" aria-hidden="true">·</span>
                  <span class="where">{row.workspaceName} › {row.pageName} › {row.tabName}</span>
                </span>
              </span>
              <span class="waited" class:bounded={!row.watched}>
                {waitLabel(row.waitedMs, row.watched)}
              </span>
            </button>
          {/each}

          {#each running as group (group.workspaceId)}
            {@const tasks = group.tasks.filter((task) => !waitingIds.has(task.sessionId))}
            {#if tasks.length > 0 || group.looseAgents > 0}
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
                {#each tasks as task (task.sessionId)}
                  <div class="item task" class:interrupted={task.phase === "interrupted"}>
                    <button type="button" class="task-main" onclick={() => openCard(task)} use:tooltip={taskTip(task)}>
                      <StatusBadge indicator={phaseIndicator(task.phase)} size={11} tip={null} />
                      <span class="item-text">
                        <span class="item-title">{task.title}</span>
                        <span class="item-meta">
                          <span class="phase {task.phase}">{PHASE_LABEL[task.phase]}</span>
                          {#if task.cardStatus}
                            <span class="sep" aria-hidden="true">·</span>
                            <span class="column-name">{task.cardStatus}</span>
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
                      <SquareTerminal size={13} />
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
            {/if}
          {/each}
        </div>
      {/if}

      <!-- What happened, over the last twelve months, summed over every
           workspace (activity/). Under the feed: what needs you now comes
           before what already happened. -->
      <section class="activity-section" aria-label="Activity">
        <h2>Activity</h2>
        <ActivityCalendar onOpenCard={openRunCard} onOpenTool={openToolsTab} />
      </section>
    </section>

    <aside class="column gauges" aria-label="Fleet">
      <!-- The four numbers a glance is for. Readouts, not buttons: each
           spans every workspace, so there is no one tab a click could
           honestly go to. -->
      <div class="bigs">
        <div class="big" class:live={stats.agents.running > 0} use:tooltip={agentsTip()}>
          <span class="big-n">{stats.agents.running}</span>
          <span class="big-l">working</span>
        </div>
        <div class="big" class:attention={inbox.length > 0}>
          <span class="big-n">{inbox.length}</span>
          <span class="big-l">waiting on you</span>
        </div>
        <!-- The count is fleetSummary's, not a tally of the feed, so this
             and the rows beside it are one number. -->
        <div class="big">
          <span class="big-n">{stats.tasks}</span>
          <span class="big-l">{stats.tasks === 1 ? "task" : "tasks"}</span>
        </div>
        <div class="big" use:tooltip={workspacesTip()}>
          <span class="big-n">{stats.workspaces}</span>
          <span class="big-l">{stats.workspaces === 1 ? "workspace" : "workspaces"}</span>
        </div>
      </div>

      <!-- The rest of the fleet, in the sidebar's own badge vocabulary: a
           hairline pill per group, a glyph and a tabular number per stat,
           colour only where it is semantic. -->
      <section class="stats" aria-label="Fleet totals">
        <span class="stat-group" role="group" use:tooltip={agentsTip()} aria-label={agentsTip()}>
          <PanelsTopLeft size={12} />
          <span class="count">{stats.agents.tabs}</span>
          <span class="stat-label">tabs</span>
          <!-- The breakdown only where there is one: a fleet with no agent
               in it would otherwise carry a divider and a bare "0". -->
          {#if stats.agents.agents > 0}
            <span class="divider" aria-hidden="true"></span>
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

        <!-- Same chips off the same fold as the sidebar's -- kanbanColumnChips
             over a summary merged by the very slug the tallies were counted
             by -- so a column's tone here and there can never disagree. -->
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
                 when nothing has a reading. -->
            <span
              class="tally usage-{worstAgent.severity}"
              use:tooltip={worstAgentTip()}
              aria-label={worstAgentTip()}>{displayPercent(worstAgent.worst.usedPercent)}%</span
            >
          {/if}
          <button type="button" class="panel-link" onclick={() => showAppPanel("usage")}>Details…</button>
        </h2>

        {#if usage.length === 0}
          <p class="empty">No workspace is running an agent yet.</p>
        {:else}
          <div class="usage-rows">
            {#each usage as row (row.profileId)}
              {@const note = usageRowNote(row, $nowStore)}
              {@const worst = row.worst}
              {@const saved = savedByProfile[row.profileId] ?? null}
              {@const savedLine = windowSavingsLine(saved)}
              <div class="usage-row">
                <span class="usage-head">
                  <span
                    class="usage-name"
                    use:tooltip={plural(row.workspaces, "workspace", "workspaces") + " running this agent"}
                    >{row.label}</span
                  >
                  {#if worst && !note}
                    <span class="pct">{displayPercent(worst.usedPercent)}%</span>
                  {/if}
                </span>
                {#if worst && !note}
                  <div class="track">
                    <!-- The bands are agentUsage.ts's; the colours only
                         name them, exactly as the usage panel draws them. -->
                    <div class="fill {row.severity}" style="width: {barPercent(worst.usedPercent)}%"></div>
                  </div>
                  <span class="usage-foot">
                    <span class="usage-window">{worst.label}</span>
                    <span class="resets">{formatResetsIn(worst.resetsAt, $nowStore) ?? ""}</span>
                    <!-- Tokens Headroom saved in this same window, from the
                         runs of the workspaces on this agent. Nothing at all
                         when none of them ran compressed in it. -->
                    {#if saved && savedLine}
                      <span class="saved" use:tooltip={windowSavingsTip(saved, worst)}>{savedLine}</span>
                    {/if}
                  </span>
                {:else}
                  <span class="usage-note">{note}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if $pausedWorkspaces.length > 0}
          <!-- A hold is the one thing on this panel that is not a readout:
               work that would have started has not. Fleet-wide, because a
               workspace on another agent is not held by this one being
               full. -->
          <p class="paused" use:tooltip={pausedTip()} aria-label={pausedTip()}>
            {plural($pausedWorkspaces.length, "workspace", "workspaces")} paused
          </p>
        {/if}
      </section>

      <!-- Every session the daemon is holding, whether or not a tab is
           showing it -- the task manager's list, folded to a recap. The rows
           here name what is stale; ending one is the panel's job, so
           nothing on the home screen kills a process. -->
      <section class="panel sessions">
        <h2>
          Sessions
          <span class="tally" class:stale={sessions.stale > 0}>{sessions.sessions}</span>
          <button type="button" class="panel-link" onclick={() => showAppPanel("sessions")}>Task manager…</button>
        </h2>

        <!-- The failure is a line ABOVE the figures, never in place of
             them, exactly as the task manager reports its own: a poll that
             failed does not unmake the last one that worked. -->
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
              <!-- The task manager's own marks: a triangle for the one case
                   with a live process nobody is hosting, a hollow ring for
                   a row whose run is over. -->
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
    </aside>
  </div>
</div>

<style>
  .hub {
    height: 100%;
    min-height: 0;
    /* The COLUMNS scroll, not the page: three panes that each keep their
       heading in view read as a dashboard, where one long page that
       scrolls them away reads as a document. The narrow layouts below
       give the page its scroll back. */
    overflow: hidden;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    font-family: monospace;
    color: var(--text);
  }
  header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }
  /* The icon's 1024 frame keeps a margin for its shadow; pull the tile
     itself into line with the column edges below it. */
  header :global(canvas) {
    margin: -4px 0 -4px -6px;
  }
  .masthead {
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 1.6em;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .version {
    margin: 2px 0 0;
    color: var(--text-subtle);
    font-size: 0.78em;
  }
  .links {
    margin-left: auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 14px;
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
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 10px;
    color: var(--text-subtle);
    text-transform: uppercase;
    font-size: 0.68em;
    letter-spacing: 0.1em;
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
  .empty {
    margin: 0;
    padding: 4px 2px;
    color: var(--text-subtle);
    font-size: 0.8em;
    line-height: 1.5;
  }

  .activity-section {
    margin-top: 22px;
  }

  /* --- the three columns --- */
  .columns {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr) 290px;
  }
  .column {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 14px 14px 20px;
  }
  .rail {
    border-right: 1px solid var(--border);
  }
  .gauges {
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* Two columns when the window narrows: the gauges drop under both and
     the page scrolls. The hub shares the width with the sidebar, so these
     fire earlier than the numbers suggest. */
  @media (max-width: 1180px) {
    .hub {
      overflow-y: auto;
    }
    .columns {
      flex: 0 0 auto;
      grid-template-columns: 220px minmax(0, 1fr);
    }
    .column {
      overflow-y: visible;
    }
    .gauges {
      grid-column: 1 / -1;
      border-left: 0;
      border-top: 1px solid var(--border);
    }
  }
  @media (max-width: 760px) {
    .columns {
      grid-template-columns: minmax(0, 1fr);
    }
    .rail {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
  }

  /* --- workspaces --- */
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: stretch;
    text-align: left;
    /* A box per workspace: a hairline all round so neighbours never run
       together, and the accent stripe on the left. */
    border: 1px solid var(--border);
    border-left: 3px solid var(--row-accent);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    padding: 8px 9px 8px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.82em;
  }
  .row:hover {
    background: var(--surface-hover);
    border-color: var(--border-strong);
    border-left-color: var(--row-accent);
  }
  .row.current {
    background: var(--surface-selected);
    border-color: var(--border-accent);
    border-left-color: var(--row-accent);
  }
  .row-main,
  .row-detail {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .busy {
    flex: 0 0 auto;
    color: var(--accent-text);
    font-size: 0.9em;
    font-variant-numeric: tabular-nums;
  }
  .recap {
    color: var(--text-muted);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .root {
    min-width: 0;
    color: var(--text-subtle);
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .age {
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 0.85em;
  }
  .new,
  .new-name {
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

  /* --- now --- */
  .feed {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
    color: var(--text);
    font: inherit;
    text-align: left;
  }
  .item-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item-title {
    font-size: 0.88em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-meta {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    color: var(--text-subtle);
    font-size: 0.74em;
  }
  .item-meta > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-meta > .sep,
  .item-meta > .phase,
  .item-meta > .reason {
    flex: 0 0 auto;
  }
  /* A wait is the one thing in the feed that wants you, so it carries the
     waiting tone as its edge and a wash of it as its ground. */
  .waiting-row {
    padding: 9px 12px;
    border-color: var(--border-warning);
    border-left: 3px solid var(--warning-text);
    background: color-mix(in srgb, var(--warning-text) 8%, var(--surface-raised));
    cursor: pointer;
  }
  .waiting-row:hover {
    background: color-mix(in srgb, var(--warning-text) 14%, var(--surface-raised));
  }
  .waiting-row:focus-visible {
    outline: 1px solid var(--border-accent);
    outline-offset: -1px;
  }
  /* Only the broken rows get a colour of their own: a failure is the one
     wait in the list that is not merely patient. */
  .waiting-row.reason-failed {
    border-color: var(--border-danger);
    border-left-color: var(--danger-text);
    background: color-mix(in srgb, var(--danger-text) 8%, var(--surface-raised));
  }
  .waiting-row.reason-failed .reason {
    color: var(--danger-text);
  }
  .waited {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 0.75em;
    font-variant-numeric: tabular-nums;
  }
  /* A wait gavin did not watch begin. Quieter than a measured one, and
     the "≥" it carries is spelled out in the row's own bubble. */
  .waited.bounded {
    color: var(--text-subtle);
  }
  /* The workspace's accent, as a rule down the left of its whole group:
     the group is the workspace, the rows are its cards. */
  .group {
    margin-top: 6px;
    padding-left: 9px;
    border-left: 2px solid var(--row-accent);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.7em;
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
    gap: 0;
    align-items: stretch;
  }
  .task:hover {
    border-color: var(--border-strong);
  }
  .task.interrupted {
    border-color: var(--border-warning);
  }
  .task-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 6px 8px 12px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  /* The same phases the badge draws, worded. Only interrupted is
     coloured -- working is background information, and idle is the
     absence of news; a wait is already a row of its own above. */
  .phase.interrupted {
    color: var(--warning-text);
  }
  .phase.failed {
    color: var(--danger-text);
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
    padding: 0 11px;
    background: none;
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0 8px 8px 0;
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
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.75em;
  }

  /* --- gauges --- */
  .bigs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .big {
    display: flex;
    flex-direction: column;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .big-n {
    font-size: 1.8em;
    font-weight: 700;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .big-l {
    color: var(--text-subtle);
    font-size: 0.68em;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  /* Colour only when the number is news: work in flight, a human wanted. */
  .big.live .big-n {
    color: var(--accent-text);
  }
  .big.attention {
    border-color: var(--border-warning);
  }
  .big.attention .big-n {
    color: var(--warning-text);
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 0.78em;
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
  /* The same three tokens IndicatorTone maps to, so this group and a
     badge beside it are the same amber. */
  .memory-group.tone-warning {
    color: var(--warning-text);
    border-color: var(--warning-text);
  }
  .memory-group.tone-danger {
    color: var(--danger-text);
    border-color: var(--danger-text);
  }
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
  .card-col.progress {
    color: var(--accent-text);
  }
  .stat.done,
  .card-col.done {
    color: var(--success-text);
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
  .panel {
    display: flex;
    flex-direction: column;
  }
  /* The panel's own action, at the end of its heading: the recap says
     what there is, the panel it opens is where anything is done about it. */
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
  .usage-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.8em;
  }
  .usage-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-sunken);
    min-width: 0;
  }
  .usage-head,
  .usage-foot {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .usage-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .pct {
    flex: 0 0 auto;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .track {
    height: 5px;
    background: var(--border);
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
  .usage-foot {
    font-size: 0.9em;
  }
  .usage-window {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .resets {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
  }
  .saved {
    margin-left: auto;
    flex: 0 0 auto;
    white-space: nowrap;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  /* A sentence where a bar would be: no probe, no reading yet, or a
     reading that carried no windows. */
  .usage-note {
    color: var(--text-subtle);
  }
  /* The heading badge takes the bands' own tones, so the number at the
     top and the bar it came from can never disagree. */
  .tally.usage-warn {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .tally.usage-critical {
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  /* Stale rows are the reason to open the panel, so the count says so. */
  .tally.stale {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .paused {
    margin: 8px 0 0;
    color: var(--warning-text);
    font-size: 0.78em;
  }
  .cost {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
    color: var(--text-muted);
    font-size: 0.8em;
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
  /* The one kind with a live process nobody is hosting. */
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
</style>
