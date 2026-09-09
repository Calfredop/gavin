import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

// The static pre-flight for the memory wall.
//
// Everything the wall DECIDES is pure and covered elsewhere
// (launchGate.test.ts, launchQueue.test.ts, launchEstimate.test.ts,
// memory.test.ts). What no suite can see is the WIRING: a board card
// that computes its own idea of "queued", a confirm dialog that never
// passes an estimate, a settings panel that writes through the
// workspaces save instead of the launch config, an action module that
// spawns a session without asking the gate at all. Every one of those
// type-checks and renders perfectly, and every one of them puts the app
// back where it was on the day eleven rails rebooted the Mac.
//
// Reads the committed source rather than the rendered DOM, following
// appHubSurface.test.ts and autoCommitSurfaces.test.ts: mounting a
// component to assert "this store was read" tests the harness, and a
// component `<style>` is compiled away before a test could see it.

const SVELTE = svelteSources();

const TS = tsSources();

/// The route file, which is where every app-wide banner is actually
/// mounted. Its own glob because it lives outside `src/lib`.
const ROUTES = import.meta.glob("../routes/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = name.endsWith(".svelte") ? SVELTE[name] : TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("every start goes through the gate", () => {
  // The card's whole premise: ONE gate, and every "run this" request
  // from any source passes it. A launcher that skipped it would be a
  // hole exactly where somebody starts eleven of something.
  const ROUTED: Array<[string, string]> = [
    ["cardRunActions.ts", "runCard / resumeCard / reviewCardSession / developCard / relaunchCard"],
    ["workspaceToolsActions.ts", "the Tools tab's standalone runs"],
    ["codeReviewActions.ts", "Review with agent"],
    ["gitState.ts", "Commit via agent"],
    ["orchestrationState.ts", "Generate and a rail's Reorganize"],
  ];

  for (const [file, what] of ROUTED) {
    it(`routes ${what} through holdOrQueue`, () => {
      expect(source(file)).toContain("holdOrQueue");
    });
  }

  // The way back in. A kind the queue can enqueue but not run would sit
  // in the queue for ever, and the drain would throw on every pass.
  const RUNNERS: Array<[string, string]> = [
    ["cardRunActions.ts", "launchQueuedCard"],
    ["workspaceToolsActions.ts", "launchQueuedTool"],
    ["codeReviewActions.ts", "launchQueuedReview"],
    ["gitState.ts", "launchQueuedCommit"],
    ["orchestrationState.ts", "launchQueuedOrchestrationAgent"],
  ];

  for (const [file, fn] of RUNNERS) {
    it(`exports ${fn}, which is what the drain calls`, () => {
      expect(source(file)).toContain(`export async function ${fn}(`);
      // ...and the queue dispatches to it by that exact name.
      expect(source("launchQueue.ts")).toContain(`m.${fn}(`);
    });
  }

  // A rail step is NOT queued -- the scheduler is the rail's queue -- so
  // it is skipped at the seam the pause already uses, and the gate's
  // deduped flag has to be a tick input or the skipped action is never
  // emitted again.
  it("skips a rail launch at the pause's own seam, with the flag in tickInputStores", () => {
    const orch = source("orchestrationState.ts");
    expect(orch).toContain("if (!mayStartWork(workspaceId)) continue;");
    expect(orch).toContain("if (!mayLaunch()) continue;");
    expect(orch).toMatch(/tickInputStores[\s\S]*?launchHolding/);
  });

  // A pause DEFERS a resume; the wall does the same. Spending the one
  // automatic attempt on a launch the gate is about to hold would cost a
  // real failure its recovery.
  it("defers an auto-resume rather than spending its attempt", () => {
    const auto = source("autoResumeState.ts");
    expect(auto).toContain("if (!mayLaunch()) {");
    expect(auto).toContain("armWait(sessionId, previousStatus, PAUSE_RECHECK_MS, entry.key);");
  });

  // One sentence per surface: the pause's reason first, then the gate's.
  it("answers startBlockedReason with the pause first and the gate second", () => {
    const pause = source("agentPauseState.ts");
    expect(pause).toContain("if (paused) return paused;");
    expect(pause).toContain("return gateReason();");
    expect(source("launchQueue.ts")).toContain("setGateReasonHook(launchBlockedReason);");
  });
});

describe("the queued marks", () => {
  it("draws the board card's badge from the one indicator vocabulary", () => {
    const card = source("BoardCard.svelte");
    expect(card).toContain("agentQueuedIndicator(");
    expect(card).toContain("queuedBadgeText(");
    expect(card).toContain("queuedForCard(workspaceId, card.id)");
    // Cancellable from the card itself, and the badge hangs on a
    // NON-disabled button: tooltip.ts binds mouseenter, which a disabled
    // control never fires.
    expect(card).toContain("cancelLaunch(queued.id)");
    expect(card).not.toMatch(/<button[^>]*disabled[^>]*>\s*<StatusBadge\s+indicator=\{agentQueuedIndicator/);
  });

  it("draws the detail modal's row and offers the same cancel", () => {
    const modal = source("CardDetailModal.svelte");
    expect(modal).toContain("agentQueuedIndicator(");
    expect(modal).toContain("cancelLaunch(queued.id)");
  });

  it("offers Cancel on a queued card's menu, ahead of every run entry", () => {
    const menu = source("cardMenu.ts");
    expect(menu).toContain("Cancel queued launch");
    expect(menu).toContain("cancelLaunch(queued.id)");
    // Ahead of the develop branch, which is the first of the run
    // entries: offering Run again would queue a second identical intent.
    expect(menu.indexOf("Cancel queued launch")).toBeLessThan(
      menu.indexOf("developingRunOn(workspaceId, card.id)")
    );
  });

  // A readout, not an intent: a rail is not queued, so neither surface
  // offers to cancel anything.
  it("marks a held rail and its current stage's pending steps", () => {
    const rail = source("OrchestrationRail.svelte");
    expect(rail).toContain('railState === "running" && !$launchGateVerdict.allowed');
    expect(rail).toContain("runningStageId(orch, rail.id) === stageId");
    expect(source("OrchestrationStepChip.svelte")).toContain("agentQueuedIndicator(");
  });

  // A derivation that called queuedForCard without touching the store
  // would render once and never update: the helper reads it with `get`,
  // which no derivation can see.
  it("depends on the queue store, not only on the helper that reads it", () => {
    for (const file of ["BoardCard.svelte", "CardDetailModal.svelte"]) {
      expect(source(file)).toContain("void $launchQueue;");
    }
  });
});

describe("the fleet strip and the banner", () => {
  it("draws one strip from one function, in the footer and on the hub", () => {
    expect(source("Sidebar.svelte")).toContain("$fleetStripLine");
    // The hub is PASSED the same value rather than computing a second
    // one: the two are on screen together, and two arithmetics for one
    // number is the shape that drifts.
    expect(source("AppHubView.svelte")).toContain("memory: $fleetStripLine");
    expect(source("appHub.ts")).toContain("memory: input.memory ?? null");
  });

  it("raises the banner from pressureBannerLine and ends nothing without asking", () => {
    const banner = source("MemoryPressureBanner.svelte");
    expect(banner).toContain("pressureBannerLine(");
    expect(banner).toContain('showAppPanel("sessions", "memory")');
    expect(banner).toContain("closeTabsNow(target.idle.ids)");
    // No native dialog: the capability list is narrowed to
    // `dialog:allow-open`, and every prompt names its own action.
    expect(banner).toContain("askConfirm(");
    expect(banner).not.toContain("plugin-dialog");
    // Its one close of finished agents goes through the reclaim module's
    // own asking path, never a kill of its own.
    expect(banner).toContain("reclaimDoneSessionsNow()");
    expect(banner).toContain("reclaimNowLabel(");
    expect(banner).toContain("reclaimedClause(");
    expect(banner).not.toContain("killSession");
    expect(banner).not.toContain("endSession");
  });

  // A banner nothing mounts is a component with tests and no effect.
  // Above the view boundary, like the other two: these are the app's own
  // report channel and have to survive whatever the views throw.
  it("mounts the banner beside the other two, above the view boundary", () => {
    const page = ROUTES["../routes/+page.svelte"];
    expect(page, "no source for +page.svelte").toBeTruthy();
    expect(page).toContain("<MemoryPressureBanner />");
    expect(page.indexOf("<MemoryPressureBanner />")).toBeGreaterThan(
      page.indexOf("<DaemonRequestErrorBanner />")
    );
    expect(page.indexOf("<MemoryPressureBanner />")).toBeLessThan(page.indexOf("<svelte:boundary"));
  });

  it("opens the sessions panel sorted by memory, once", () => {
    expect(source("appPanels.ts")).toContain("takeSessionSortRequest");
    expect(source("SessionsManagerModal.svelte")).toContain(
      'takeSessionSortRequest() === "memory" ? { key: "mem", dir: "desc" } : DEFAULT_SORT'
    );
  });

  it("reports what is holding memory outside gavin, and offers to drop it", () => {
    const panel = source("SessionsManagerModal.svelte");
    expect(panel).toContain("watchmanLine(watchman)");
    expect(panel).toContain("droppableRoots(watchman.roots, ownedPaths)");
    expect(panel).toContain("dropRootsConfirm(droppable)");
    expect(panel).toContain("askConfirm(prompt)");
    expect(panel).toContain("backend.watchmanForget(root)");
  });
});

describe("the done-session reclaim", () => {
  // The one thing the wall may END. Every judgement is pure and covered
  // in doneSessionReclaim.test.ts; what no suite can see is that the
  // watcher is started at all, that it closes through the app's one
  // close path, and that the rule reads a nested task's status through
  // its parent -- the trap that once made rails re-run finished work.
  it("starts from bootstrap, after the queue it makes room for", () => {
    const layout = source("layoutState.ts");
    expect(layout).toContain('await import("$lib/doneSessionReclaimState")');
    expect(layout).toContain("unlisteners.push(startDoneSessionReclaim());");
    expect(layout.indexOf("startDoneSessionReclaim()")).toBeGreaterThan(
      layout.indexOf("startLaunchQueue()")
    );
  });

  it("closes through closeSession, never a bare kill, and asks before a manual close", () => {
    const state = source("doneSessionReclaimState.ts");
    expect(state).toContain("await closeSession(next.sessionId)");
    expect(state).not.toContain("killSession");
    expect(state).toContain("askConfirm(reclaimNowPrompt(candidates))");
    expect(state).toContain("closeTabsNow(candidates.map((c) => c.sessionId))");
    expect(state).not.toContain("plugin-dialog");
  });

  it("reads the done column through effectiveStatus and spares pinned tabs", () => {
    const rule = source("doneSessionReclaim.ts");
    expect(rule).toContain("effectiveStatus(entry, plans)");
    expect(rule).toContain("isPinned(page.layout, id)");
    expect(rule).toContain("countsInFlight(state.sessionStatusById[id])");
    expect(rule).toContain("ws.mainSessionId === id");
  });

  it("has its own switch in the settings, written through the launch config", () => {
    const settings = source("GlobalSettingsModal.svelte");
    expect(settings).toContain("Close idle agents of done cards when memory runs short");
    expect(settings).toContain("editLaunch({ reclaimDoneSessions: e.currentTarget.checked })");
  });
});

describe("the Run all estimates", () => {
  const SITES: Array<[string, string]> = [
    ["OrchestrationHubView.svelte", "runAllConfirm(orch, estimateFor(workspaceId, runnableRails.length))"],
    ["KanbanColumn.svelte", "estimateFor(workspaceId, runnable.length)"],
    ["BoardSelectionBar.svelte", "selectionRunConfirm(runnable, estimateFor(workspaceId, runnable.length))"],
  ];

  for (const [file, call] of SITES) {
    it(`${file} passes an estimate to its confirm`, () => {
      expect(source(file)).toContain(call);
      // Read so the projection keeps up while the prompt is open: a
      // number frozen at the moment the dialog appeared is the number
      // that would still be wrong when the button is pressed.
      expect(source(file)).toContain("void $launchGateVerdict;");
    });
  }

  it("asks before running a selection at all, which it never used to", () => {
    const bar = source("BoardSelectionBar.svelte");
    expect(bar).toContain("ConfirmPrompt");
    expect(bar).toContain("onclick={() => (runPrompt = true)}");
  });
});

describe("the settings", () => {
  it("edits both fields through the launch config, not the workspaces save", () => {
    const settings = source("GlobalSettingsModal.svelte");
    expect(settings).toContain("Agents running at once");
    expect(settings).toContain("Hold new agents when memory is under pressure");
    expect(settings).toContain("saveLaunchConfig(");
    // Blank is a real answer -- no ceiling -- and not the shipped four.
    expect(settings).toContain("ceilingFrom(e.currentTarget.value)");
    expect(settings).toContain('placeholder="none"');
  });

  it("writes through the host's own get/set pair", () => {
    expect(source("backend.ts")).toContain('invoke("set_launch_config", { launch })');
    expect(source("backend.ts")).toContain('invoke("get_launch_config")');
  });
});

describe("the probe", () => {
  it("polls app-wide from bootstrap, not from a mounted component", () => {
    const layout = source("layoutState.ts");
    expect(layout).toContain('await import("$lib/memoryState")');
    expect(layout).toContain("unlisteners.push(startMemoryPoll());");
    expect(layout).toContain('await import("$lib/launchQueue")');
    expect(layout).toContain("unlisteners.push(startLaunchQueue());");
  });

  it("reads the machine and watchman through the host, never a bare CLI call", () => {
    expect(source("backend.ts")).toContain('invoke("system_memory")');
    expect(source("backend.ts")).toContain('invoke("watchman_status")');
    expect(source("backend.ts")).toContain('invoke("watchman_forget", { root })');
  });
});
