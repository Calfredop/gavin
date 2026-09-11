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

  it("draws the shared refreshing badge wherever cached numbers sit while a probe is in flight", () => {
    for (const file of ["AgentUsageModal.svelte", "AppHubView.svelte", "Sidebar.svelte"]) {
      const text = source(file);
      expect(text, `${file} never imported StatusBadge`).toContain(
        'import StatusBadge from "$lib/ui/StatusBadge.svelte"'
      );
      expect(text, `${file} never draws usageRefreshingIndicator`).toContain(
        "usageRefreshingIndicator"
      );
    }
  });

  it("does not invent a second spinner on the usage panel's refresh button", () => {
    const modal = source("AgentUsageModal.svelte");
    expect(modal).toContain("usageRefreshingStore");
    expect(modal).not.toMatch(/let refreshing = \$state/);
  });
});
