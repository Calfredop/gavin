import { describe, it, expect } from "vitest";

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

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
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
    expect(hub).toContain('import StatusBadge from "./ui/StatusBadge.svelte"');
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
