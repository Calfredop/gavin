import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("usage cache surfaces", () => {
  // The clock hydrates and every window runs it; the probe is the app's
  // and only the window holding its duties runs that. So "hydrate before
  // the first probe" is bootstrap's ORDER now, not one function's body.
  it("hydrates last cached readings before the first probe", () => {
    const pause = source("agentPauseState.ts");
    const start = pause.indexOf("export function startPauseClock");
    const body = pause.slice(start, pause.indexOf("export function stopPauseClock"));
    expect(body).toContain("hydrateUsageCache()");
    expect(body).not.toContain("pollAll(");

    const layout = source("layoutState.ts");
    const clock = layout.indexOf("unlisteners.push(startPauseClock());");
    const poll = layout.indexOf("unlisteners.push(whileHoldingAppDuties(startUsagePoll));");
    expect(clock).toBeGreaterThan(-1);
    expect(poll).toBeGreaterThan(clock);
  });

  it("spins each agent's Check again icon from that profile's probe, not a second badge", () => {
    const modal = source("AgentUsageModal.svelte");
    expect(modal).toContain("usageRefreshingStore");
    expect(modal).toContain("spin={!!$usageRefreshingStore[profile.id]}");
    expect(modal).not.toContain("usageRefreshingIndicator");
    expect(modal).not.toMatch(/let refreshing = \$state/);
    expect(source("IconButton.svelte")).toMatch(/\bspin\?: boolean/);
  });

  // Same shell Settings → Agents uses: one tab per agent in use, not a
  // stacked list of every profile's bars under one scroll.
  it("separates agents into tabs like the Settings Agents hub", () => {
    const modal = source("AgentUsageModal.svelte");
    expect(modal).toContain("AgentsHubTabs");
    expect(modal).toContain("profileOptionLabel");
    expect(modal).toContain("indicators={tabIndicators}");
    expect(modal).not.toContain("<h3>{profile.label}</h3>");
  });

  // Wide enough for the strip, and the strip itself does not wrap: every
  // in-use agent stays on one row instead of stacking under a 480px cap.
  it("widens so every agent tab stays on one row", () => {
    const modal = source("AgentUsageModal.svelte");
    expect(modal).toMatch(/<Modal[^>]*\bwide\b/);
    expect(modal).toContain("wrap={false}");
    expect(source("AgentsHubTabs.svelte")).toContain("flex-wrap: nowrap");
  });

  // Semaphores live on the tab strip (one per agent with a band), and
  // every panel shares one grid cell so switching never resizes the modal.
  it("puts a usage semaphore on each agent tab and locks panel height across tabs", () => {
    const modal = source("AgentUsageModal.svelte");
    expect(modal).toContain("worstProjection");
    expect(modal).toContain("usageProjectionIndicator");
    expect(modal).toContain("projectionTooltip");
    expect(modal).toContain('class="panels"');
    expect(modal).toMatch(/\.panels\s*\{[^}]*display:\s*grid/s);
    expect(modal).toMatch(/\.panel\s*\{[^}]*grid-area:\s*1\s*\/\s*1/s);
    expect(modal).toMatch(/\.panel\s*\{[^}]*visibility:\s*hidden/s);

    const tabs = source("AgentsHubTabs.svelte");
    expect(tabs).toContain("indicators");
    expect(tabs).toContain("StatusBadge");
  });

  it("does not draw a fleet-wide refreshing badge on the hub or sidebar", () => {
    expect(source("AppHubView.svelte")).not.toContain("usageRefreshingIndicator");
    expect(source("Sidebar.svelte")).not.toContain("usageRefreshingIndicator");
  });

  it("spins the collapsed Usage glyph from the same probe store as Check again", () => {
    const sidebar = source("Sidebar.svelte");
    expect(sidebar).toContain("usageRefreshingStore");
    expect(sidebar).toContain("class:usage-updating=");
    expect(sidebar).toContain(".sidebar.collapsed .footer-row.usage-updating");
  });
});
