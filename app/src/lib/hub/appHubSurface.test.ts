import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The app hub's fleet strip and its running-tasks column are pure
// arithmetic in appHub.ts (covered in appHub.test.ts) rendered by one
// template -- and the wiring BETWEEN the two is exactly what neither
// suite can see. A hub that recomputed its own totals instead of calling
// fleetSummary type-checks and renders perfectly; so does one that
// fetches every board itself, and one whose column heading counts a
// different set than the rows under it. Those are the failures this
// pins.
//
// Reads the component source rather than the rendered DOM, following
// hubTabBar.test.ts and autoCommitSurfaces.test.ts: mounting the hub to
// assert "this store was read" tests the harness, and a component
// `<style>` is compiled away before a test could see it anyway.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const HUB = "AppHubView.svelte";
const SIDEBAR = "Sidebar.svelte";

describe("the fleet strip", () => {
  it("reads its totals from fleetSummary rather than counting for itself", () => {
    const hub = source(HUB);
    expect(hub).toContain("fleetSummary(fleet)");
    expect(hub).toContain("runningTasks(fleet)");
    // One bundle behind both, so the strip and the column can never be
    // computed from different snapshots of the stores.
    expect(hub).toMatch(/const fleet = \$derived\(\{/);
  });

  it("draws its card chips with the sidebar's own fold, not a second one", () => {
    const hub = source(HUB);
    expect(hub).toContain("kanbanColumnChips(stats.cards)");
    expect(hub).toContain("railStripStats(stats.rails)");
    // The same gate that decides whether a workspace has a git chip at
    // all -- a run in flight earns it with no repos behind it.
    expect(hub).toContain("showGitChip(stats.git)");
  });

  it("leaves the fetching to the sidebar, which already requests every rooted workspace", () => {
    // The hub is only ever on screen WITH the sidebar (+page.svelte
    // renders both), and a second requester would double the traffic
    // and could disagree about what has loaded.
    expect(source(SIDEBAR)).toContain("void fetchBoard(ws.id)");
    expect(source(SIDEBAR)).toContain("void fetchOrchestration(ws.id)");
    expect(source(HUB)).not.toContain("fetchBoard");
    expect(source(HUB)).not.toContain("fetchOrchestration");
  });
});

describe("the running-tasks column", () => {
  it("heads itself with the very number the strip was built from", () => {
    // Not groups.reduce(...) spelled out again here: two tallies over
    // one list is the shape that drifts, and the heading is the first
    // thing a human compares against the rows.
    expect(source(HUB)).toContain("{stats.tasks}");
  });

  it("jumps to the card the way every other surface does", () => {
    const hub = source(HUB);
    expect(hub).toContain("openLinkedCard(task.workspaceId, task)");
    // The terminal follows the TAB, which can have been dragged into
    // another workspace long after the card bound to it.
    expect(hub).toContain("switchToSessionInPage(task.pageWorkspaceId, task.pageId, task.sessionId)");
  });

  it("words every phase from PHASE_LABEL, so the row and its tooltip agree", () => {
    const hub = source(HUB);
    expect(hub).toContain("PHASE_LABEL[task.phase]");
    // Twice: once in the row, once in the tooltip that spells the row
    // out. Neither may hand-write the word.
    expect(hub.match(/PHASE_LABEL\[task\.phase\]/g)?.length).toBe(2);
  });

  it("draws every phase through the shared agent badge, the interrupted and failed ones by name", () => {
    const hub = source(HUB);
    // The same StatusBadge the board card draws for the same session,
    // from ui/indicators.ts -- not a private dot per phase.
    expect(hub).toContain("indicator={phaseIndicator(task.phase)}");
    expect(hub).toContain('import StatusBadge from "$lib/ui/StatusBadge.svelte"');
    // The two phases that are not daemon statuses get their own entries;
    // the rest map onto the agent states by name.
    expect(hub).toContain('if (phase === "interrupted") return agentInterruptedIndicator();');
    expect(hub).toContain('if (phase === "failed") return agentIndicator("failed");');
    expect(hub).not.toContain('class="dot');
  });

  it("says so when a workspace has busy agents but no cards behind them", () => {
    expect(source(HUB)).toContain("group.looseAgents > 0");
  });
});

describe("the agent usage recap", () => {
  it("folds it through appHub.ts rather than reading the reports itself", () => {
    const hub = source(HUB);
    expect(hub).toContain("usageRecap({");
    expect(hub).toContain("worstUsageRow(usage)");
    // Three absences, one place that words them: a profile nobody has
    // read yet, one that publishes nothing, and a reading with no
    // windows are different sentences, and a template that tested
    // `report == null` itself would collapse two of them.
    expect(hub).toContain("usageRowNote(row, $nowStore)");
  });

  it("fetches nothing: the pause clock already reads every profile in use", () => {
    // startPauseClock polls app-wide whether or not the hub is open, so
    // a second requester here would double the calls against a route
    // that 429s.
    expect(source(HUB)).not.toContain("refreshUsage");
    expect(source(HUB)).toContain('from "$lib/agents/agentPauseState"');
  });

  it("draws the bar in the bands agentUsage.ts owns, never a percentage of its own", () => {
    const hub = source(HUB);
    expect(hub).toContain("barPercent(worst.usedPercent)");
    expect(hub).toContain("displayPercent(worst.usedPercent)");
    expect(hub).toContain('class="fill {row.severity}"');
  });

  it("reports a hold across the whole fleet, not just the active workspace", () => {
    // `activePause` answers for the workspace in front of you, which on
    // an app-level surface is the wrong question.
    const hub = source(HUB);
    expect(hub).toContain("$pausedWorkspaces.length > 0");
    expect(hub).not.toContain("$activePause");
  });
});

describe("the sessions recap", () => {
  it("builds its rows with the task manager's own builder", () => {
    // One set of rules for naming, placing and calling a session stale,
    // wherever it is shown.
    const hub = source(HUB);
    expect(hub).toContain("sessionRows({");
    expect(hub).toContain("sessionsRecap(managed)");
    expect(hub).toContain("totalsCoverage(sessions.totals)");
    expect(hub).toContain("formatCpu(sessions.totals.cpuPercent)");
    expect(hub).toContain("formatMemory(sessions.totals.memBytes)");
  });

  it("stops sampling the process table when the hub goes away", () => {
    // No store holds the session list, so this surface polls -- and the
    // daemon walks every session's process tree to answer. +page.svelte
    // mounts the hub behind `{#if $appHubOpen}`, so the teardown is what
    // makes leaving it stop.
    const hub = source(HUB);
    expect(hub).toContain("onDestroy");
    expect(hub).toContain("clearInterval(sessionsTimer)");
  });

  it("does not poll behind the panel that is already polling", () => {
    // The task manager samples at two seconds while it is open, drawn
    // over this. Two walks of the process table for one screen is what
    // the guard prevents.
    expect(source(HUB)).toContain('if ($openAppPanel === "sessions") return;');
  });

  it("guards a late reply with a counter, never with identity", () => {
    // Svelte 5 proxies $state objects, so `sample !== next` is always
    // true and cannot decide whether a reply is still wanted.
    expect(source(HUB)).toContain("mine !== sessionsEpoch");
  });

  it("does not let a failed poll become the baseline for the next rate", () => {
    const hub = source(HUB);
    const failure = hub.indexOf("sessionsError = e instanceof Error");
    const shift = hub.indexOf("previousSample = sample;");
    expect(failure).toBeGreaterThan(-1);
    expect(shift).toBeGreaterThan(failure);
  });

  it("holds an empty list back until a reply has actually arrived", () => {
    // "The daemon is holding no sessions" is the one answer this recap
    // must never give wrongly, and it is what an unfilled list looks
    // like.
    const hub = source(HUB);
    expect(hub).toContain("{#if !sessionsLoaded}");
    expect(hub.indexOf("{#if !sessionsLoaded}")).toBeLessThan(
      hub.indexOf("The daemon is holding no sessions.")
    );
  });

  it("reports a failed poll beside the figures rather than instead of them", () => {
    // A poll that failed does not unmake the last one that worked, and
    // blanking the recap would lose numbers it is still honest about --
    // the same shape the task manager's own error banner has.
    const hub = source(HUB);
    expect(hub.indexOf("{#if sessionsError}")).toBeLessThan(hub.indexOf("{#if !sessionsLoaded}"));
  });

  it("says why the figures are missing rather than drawing blank ones", () => {
    // Blank cells would read as "these sessions cost nothing", which is
    // a measurement nobody took.
    expect(source(HUB)).toContain('featureBlockedReason($daemonCompat, "sessionMetrics")');
  });

  it("names what is stale but never ends it from the home screen", () => {
    // Ending a session is the task manager's job -- it is where the
    // confirmations name the process being killed.
    const hub = source(HUB);
    expect(hub).toContain('showAppPanel("sessions")');
    expect(hub).not.toContain("endSession");
    expect(hub).not.toContain("endStaleSessions");
    expect(hub).not.toContain("restartDaemon");
  });

  it("says how many stale rows it left out rather than quietly showing four", () => {
    expect(source(HUB)).toContain("sessions.more > 0");
  });
});
