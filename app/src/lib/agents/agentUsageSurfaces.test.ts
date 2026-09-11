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
  it("hydrates last cached readings before the first probe", () => {
    const pause = source("agentPauseState.ts");
    const start = pause.indexOf("export function startPauseClock");
    const body = pause.slice(start, pause.indexOf("export function stopPauseClock"));
    expect(body).toContain("hydrateUsageCache");
    expect(body.indexOf("hydrateUsageCache()")).toBeLessThan(body.lastIndexOf("void pollAll()"));
  });

  it("spins each agent's Check again icon from that profile's probe, not a second badge", () => {
    const modal = source("AgentUsageModal.svelte");
    expect(modal).toContain("usageRefreshingStore");
    expect(modal).toContain("spin={!!$usageRefreshingStore[profile.id]}");
    expect(modal).not.toContain("usageRefreshingIndicator");
    expect(modal).not.toMatch(/let refreshing = \$state/);
    expect(source("IconButton.svelte")).toMatch(/\bspin\?: boolean/);
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
