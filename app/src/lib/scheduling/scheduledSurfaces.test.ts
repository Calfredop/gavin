import { describe, expect, it } from "vitest";
import { HUB_VIEW_META, hubViewAttention, tabStripHubViewIds, visibleHubViewIds } from "$lib/hub/hubViewMeta";
import { source } from "$lib/sources";

// The Scheduled tab's wiring, read from source (reviewSurfaces.test.ts's
// reason): a tab with no component crashes at render, a dialog nobody
// mounts never opens, and a surface that sends the new requests with no
// compat gate goes blank against an older daemon instead of saying why.

/// The page that mounts the dialog and feeds the strip's marks. It sits
/// outside lib, so the lib source map does not hold it.
const page = Object.values(
  import.meta.glob("../../routes/+page.svelte", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >
)[0];

describe("the tab's registration", () => {
  it("is a hub tab that needs a root, beside Review", () => {
    const meta = HUB_VIEW_META.find((v) => v.id === "scheduled");
    expect(meta).toMatchObject({ label: "Scheduled", requiresRoot: true });
    expect(tabStripHubViewIds(true)).toContain("scheduled");
    expect(visibleHubViewIds(false)).not.toContain("scheduled");
    const ids = HUB_VIEW_META.map((v) => v.id);
    expect(ids.indexOf("scheduled")).toBe(ids.indexOf("review") + 1);
  });

  it("has a component bound to its id", () => {
    expect(source("workspaceViews.ts")).toContain("scheduled: { icon: CalendarClock, component: ScheduledHubView }");
  });

  it("wears a dot when a latest run failed or left no report, and nowhere else", () => {
    const quiet = { committing: false, railsWantingAttention: false };
    expect(hubViewAttention("scheduled", { ...quiet, scheduledWantsLook: true })).toBe(true);
    expect(hubViewAttention("decisions", { ...quiet, scheduledWantsLook: true })).toBe(false);
    expect(page).toContain("scheduledWantsLook: activeWorkspace");
  });
});

describe("the surfaces", () => {
  it("offer every control the design names", () => {
    const view = source("ScheduledHubView.svelte");
    for (const label of [
      "Edit schedule",
      "controls.pauseLabel",
      "Run now",
      "Open report",
      "Open card",
      "Duplicate",
      "Delete",
      "Unschedule",
      "New scheduled task",
      "Raw output",
      "Earlier reports",
    ]) {
      expect(view, label).toContain(label);
    }
  });

  it("shows a run going in its live terminal, keyed on the session", () => {
    expect(source("ScheduledHubView.svelte")).toMatch(
      /\{#key sessionId\}\s*<TerminalPane \{sessionId\}/
    );
  });

  it("mount the Schedule dialog once, from the store", () => {
    expect(page).toContain("<ScheduleDialog request={$scheduleRequest}");
  });

  it("offer Schedule… on cards in the menu and the detail modal", () => {
    expect(source("cardMenu.ts")).toContain('label: "Schedule…"');
    expect(source("CardDetailModal.svelte")).toContain("Schedule…");
    expect(source("ScheduleDialog.svelte")).toContain("Makes a Scheduled task");
  });

  it("gate every surface that sends the new requests on the daemon's version", () => {
    expect(source("scheduledState.ts")).toContain('featureBlockedReason(get(daemonCompat), "scheduledTasks")');
    expect(source("CardDetailModal.svelte")).toContain('featureBlockedReason($daemonCompat, "scheduledTasks")');
    // The tab and the menu go through the same reason.
    expect(source("ScheduledHubView.svelte")).toContain("scheduledBlockedReason(workspaceId)");
    expect(source("cardMenu.ts")).toContain("scheduledBlockedReason(workspaceId)");
  });

  it("start the scheduler beside the rail one, in bootstrap", () => {
    expect(source("layoutState.ts")).toContain("unlisteners.push(startScheduledScheduler());");
  });
});
