import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";
import { BUILTIN_TOOLS, toolPlatformBlockedReason, type Tool } from "$lib/orchestration/orchestrationTools";

// `builtin:send-email` drives Mail.app and has nowhere else to run --
// `xdg-email` opens a composer and never sends, and sending for real
// needs an SMTP account gavin does not hold. So it declares its
// platform, and three surfaces have to ask before offering it. Miss one
// and the tool is offered off macOS, where the only thing it can produce
// is `osascript: command not found`.
//
// The surfaces read their SOURCE rather than mounting: the drawer needs a
// daemon and a window, and the launch path needs a PTY. What is pinned is
// that each one reaches for the shared reason -- not the wording, which
// lives in orchestrationTools.test.ts, and not a second copy of it.

describe("a tool this machine cannot run", () => {
  it("is a fact the built-in set actually declares", () => {
    const mailer = BUILTIN_TOOLS.find((t) => t.id === "builtin:send-email") as Tool;
    expect(toolPlatformBlockedReason(mailer, "linux")).toContain("only on macOS");
    expect(toolPlatformBlockedReason(mailer, "macos")).toBeNull();
  });

  // The drawer: listed, inert, and with no drag handle. NOT hidden --
  // both pickers already have a posture for a tool that cannot be placed
  // and it is this one, and hiding would take Duplicate away from the
  // built-in a Linux human most wants to re-point at their own mailer.
  it("is still drawn in the drawer, disabled, with the reason on the row", () => {
    const drawer = source("OrchestrationDrawer.svelte");
    expect(drawer).toContain("toolPlatformBlockedReason(tool, currentPlatform())");
    // The daemon gate and the platform gate fold into ONE reason, so the
    // row cannot end up disabled by one while wearing the other's title.
    expect(drawer).toMatch(/\{@const blocked = toolsBlocked \?\? toolPlatformBlockedReason\(/);
    expect(drawer).toMatch(/disabled=\{Boolean\(blocked\) \|\| !targetRailId\}/);
    expect(drawer).toMatch(/title=\{blocked \?\?/);
    // The glue takes any row wearing the attribute as a drag subject,
    // disabled or not, so `disabled` alone is a look and not a lock.
    expect(drawer).toMatch(/data-orch-tool=\{blocked \|\| !targetRailId \? undefined : tool\.id\}/);
    // No filtering anywhere: the list the human is standing in must not
    // lose rows.
    expect(drawer).not.toMatch(/view\.tools\.filter/);
  });

  // The Tools tab: the same sentence, through the same table every other
  // dark-Run reason comes from.
  it("darkens the Tools tab's Run button through runBlockedReason", () => {
    expect(source("workspaceTools.ts")).toContain("toolPlatformBlockedReason(input.tool, input.platform)");
    // The Run button is the explorer's; WorkspaceToolsHubView only frames it.
    expect(source("ToolsExplorerView.svelte")).toContain("platform: currentPlatform()");
    // And the launch itself, for the paths that never touch the button
    // -- a queued run draining is the real one.
    expect(source("workspaceToolsActions.ts")).toContain(
      "toolPlatformBlockedReason(tool, currentPlatform())"
    );
  });

  // A rail authored on a mac and opened here. The drawer will not place
  // one, so this is the case the drawer cannot cover.
  it("stalls a rail step with the reason instead of launching it", () => {
    const state = source("orchestrationState.ts");
    const at = state.indexOf("const unsupported = toolPlatformBlockedReason(");
    expect(at).toBeGreaterThan(0);
    const after = state.slice(at, at + 260);
    expect(after).toMatch(/setStepRunAction\(workspaceId, step\.id, "stalled", null, unsupported\)/);
    // Before the kind branches: this is a fact about the tool, not about
    // what running it would involve.
    expect(at).toBeLessThan(state.indexOf('if (tool.kind === "gavin")'));
  });
});
