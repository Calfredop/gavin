// A workspace's tools, run from the phone: what the Tools surface lists,
// and every launch's traffic, read at the wire against the Demo
// Workstation.
//
// What a run pins is what the Workstation is ASKED: the desk's own
// command line for the tool, the run filed with the daemon, the tab
// named -- and nothing that places the session or saves the desk's
// layout, which is the desk's to do (companion-16).
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { layoutState } from "$lib/core/layoutState";
import { toolRunsStore } from "$lib/orchestration/toolRunsState";
import { renderLibraryFor, toolRecords } from "$lib/orchestration/toolsState";
import { lastRunsFor } from "$lib/workspace/workspaceTools";
import type { BundleMessage } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { setStatus } from "$companion/demo/sessions";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { startedHere } from "$companion/state/sessions";
import { loadTools, runTool } from "$companion/state/tools";
import { connectWorkstation, openWorkspace, showSurface, view } from "$companion/state/workstation";
import { toolGroups } from "$companion/surfaces/phoneTools";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
});

async function visit(demo: DemoWorkstation = createDemoWorkstation()): Promise<DemoWorkstation> {
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  openWorkspace(DEMO.atlas);
  showSurface("tools");
  await loadTools(DEMO.atlas);
  await settle();
  return demo;
}

function sentSince(demo: DemoWorkstation, from: number): { cmd: string; args: Record<string, unknown> }[] {
  return demo
    .received()
    .slice(from)
    .flatMap((m: BundleMessage) => (m.type === "invoke" ? [{ cmd: m.cmd, args: m.args }] : []));
}

function groups() {
  const workspace = get(layoutState).workspaces.find((w) => w.id === DEMO.atlas);
  return toolGroups({
    library: renderLibraryFor(get(toolRecords), DEMO.atlas),
    lastRuns: lastRunsFor(get(toolRunsStore), DEMO.atlas),
    search: "",
    compat: null,
    rootPath: workspace?.rootPath ?? null,
    nowMs: Date.now(),
  });
}

function row(name: string) {
  const found = groups()
    .flatMap((g) => g.rows)
    .find((r) => r.name === name);
  if (!found) throw new Error(`no tool ${name} on the Tools surface`);
  return found;
}

describe("the Tools surface", () => {
  it("is read only once it is shown", async () => {
    const demo = createDemoWorkstation();
    disconnect = await connectWorkstation(loopback(demo), deviceStorage());
    await settle();
    openWorkspace(DEMO.atlas);
    await settle();
    expect(demo.commands()).not.toContain("get_tools");
    expect(demo.commands()).not.toContain("tool_runs");
  });

  it("lists the workspace's own tools, then the global ones, then the built-ins, with their last runs", async () => {
    await visit();
    expect(groups().map((g) => g.title)).toEqual(["This workspace", "All workspaces", "Built-in"]);
    expect(groups()[0].rows.map((r) => r.name)).toEqual(["Deploy to staging", "Draft the changelog", "Lint"]);
    expect(groups()[1].rows.map((r) => r.name)).toEqual(["Disk space"]);
    expect(row("Lint").run?.chip).toMatch(/^passed · /);
    expect(row("Deploy to staging").run?.sentence).toBe("Failed — it exited with code 1.");
    expect(row("Disk space").run).toBeNull();
  });

  it("darkens Run on a tool that only means something on a rail, and says why", async () => {
    const demo = await visit();
    expect(row("Lint").blocked).toBeNull();
    const until = groups()
      .flatMap((g) => g.rows)
      .find((r) => r.id === "builtin:until");
    expect(until?.blocked).toMatch(/rail/);
    const from = demo.received().length;
    expect(await runTool(DEMO.atlas, "builtin:until", {})).toMatch(/rail/);
    expect(sentSince(demo, from).map((s) => s.cmd)).not.toContain("create_session");
  });
});

describe("running a command or a script tool", () => {
  it("launches the desk's command line, files the run, and leaves the session to the desk to place", async () => {
    const demo = await visit();
    const from = demo.received().length;
    expect(await runTool(DEMO.atlas, "demo-tool-deploy", { branch: "release/2" })).toBeNull();
    await settle();

    const sent = sentSince(demo, from);
    const create = sent.find((s) => s.cmd === "create_session");
    expect(create?.args.cwd).toBe(DEMO.atlasRoot);
    expect(String(create?.args.command)).toContain("./scripts/deploy.sh staging release/2");
    expect(String(create?.args.command)).toContain("bash -c");
    expect(create?.args.profileId).toBeUndefined();
    const sessionId = String(demo.state.toolRuns.at(-1)?.sessionId);
    expect(sent.find((s) => s.cmd === "start_tool_run")?.args).toMatchObject({
      workspaceId: DEMO.atlas,
      toolId: "demo-tool-deploy",
      sessionId,
      launchCwd: DEMO.atlasRoot,
      conversationId: null,
    });
    expect(sent.find((s) => s.cmd === "set_session_name")?.args).toEqual({ sessionId, name: "Deploy to staging" });
    for (const cmd of LAYOUT_SAVING_COMMANDS) expect(sent.map((s) => s.cmd)).not.toContain(cmd);

    // Listed as this phone's, and NOT opened: a shell tool's session can
    // end in a moment, and the Tools surface is where its verdict lands.
    expect(get(startedHere)[sessionId]).toBe(DEMO.atlas);
    expect(get(view)).toMatchObject({ surface: "tools", sessionId: null });
    expect(row("Deploy to staging").run).toMatchObject({ open: true });
    expect(row("Deploy to staging").blocked).toMatch(/already running/);
  });

  it("refuses a second run while the first is open", async () => {
    const demo = await visit();
    expect(await runTool(DEMO.atlas, "demo-tool-lint", {})).toBeNull();
    await settle();
    const from = demo.received().length;
    expect(await runTool(DEMO.atlas, "demo-tool-lint", {})).toMatch(/already running/);
    expect(sentSince(demo, from).map((s) => s.cmd)).not.toContain("create_session");
  });

  it("reads the verdict again when the session ends", async () => {
    const demo = await visit();
    await runTool(DEMO.atlas, "demo-tool-lint", {});
    await settle();
    const from = demo.received().length;
    demo.advance();
    await settle();
    expect(sentSince(demo, from).map((s) => s.cmd)).toContain("tool_runs");
    expect(row("Lint").run).toMatchObject({ open: false, sentence: "Finished — it exited cleanly." });
    expect(row("Lint").blocked).toBeNull();
  });
});

describe("running an agent tool", () => {
  it("launches the workspace's agent with the tool's prompt, and opens its terminal", async () => {
    const demo = await visit();
    const from = demo.received().length;
    expect(await runTool(DEMO.atlas, "demo-tool-changelog", { since: "v2.0.0" })).toBeNull();
    await settle();

    const create = sentSince(demo, from).find((s) => s.cmd === "create_session");
    expect(String(create?.args.command)).toContain("Read the commits since v2.0.0");
    expect(create?.args.profileId).toBe("claude-code");
    const sessionId = String(demo.state.toolRuns.at(-1)?.sessionId);
    expect(get(view)).toMatchObject({ workspaceId: DEMO.atlas, sessionId });
  });

  it("files the run as passed once the agent has worked and gone quiet", async () => {
    const demo = await visit();
    await runTool(DEMO.atlas, "demo-tool-changelog", {});
    await settle();
    const sessionId = String(demo.state.toolRuns.at(-1)?.sessionId);
    const from = demo.received().length;

    // Idle at its first prompt is not a finished turn.
    setStatus(demo, sessionId, "idle");
    await settle();
    expect(sentSince(demo, from).map((s) => s.cmd)).not.toContain("set_tool_run_outcome");

    setStatus(demo, sessionId, "working");
    await settle();
    setStatus(demo, sessionId, "idle");
    await settle();
    const filed = sentSince(demo, from).filter((s) => s.cmd === "set_tool_run_outcome");
    expect(filed.map((s) => s.args)).toEqual([{ sessionId, outcome: "passed", exitCode: null }]);
    expect(row("Draft the changelog").run).toMatchObject({ open: false });
  });

  it("leaves the verdict of a run it did not start to the desk", async () => {
    const demo = await visit();
    demo.state.toolRuns.push({
      ...demo.state.toolRuns[0],
      id: 99,
      toolId: "demo-tool-changelog",
      sessionId: "s-atlas-auth",
      outcome: "running",
      endedAt: null,
      exitCode: null,
    });
    await loadTools(DEMO.atlas);
    await settle();
    const from = demo.received().length;
    setStatus(demo, "s-atlas-auth", "waiting_for_input");
    await settle();
    setStatus(demo, "s-atlas-auth", "idle");
    await settle();
    expect(get(layoutState).sessionsSeenWorking.has("s-atlas-auth")).toBe(true);
    expect(sentSince(demo, from).map((s) => s.cmd)).not.toContain("set_tool_run_outcome");
  });
});
