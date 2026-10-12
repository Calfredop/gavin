// Seam 2 for "Commit via agent" on the phone: the phone's ask on one end
// of the channel, the Demo Workstation playing the desk on the other, and
// the wire between them read message by message.
//
// The phone asks and the desk runs (decision A of
// companion-git-has-no-commit-via-agent): one `agent_commit_for_device`
// on the wire, the desk's hidden agent and its record at the Workstation,
// and the phone drawing that record -- never a session of its own, never
// a kill, never the desk's layout.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  agentDefaultsStore,
  agentModelDefaultsStore,
  agentProfilesStore,
  layoutState,
  trustedAgentConfigs,
} from "$lib/core/layoutState";
import { agentCommitPhase, ensureGitView, gitStore, refresh, startWatching, type GitViewState } from "$lib/git/gitState";
import { loopback } from "$companion/channel/port";
import { AGENT_COMMIT_COMMANDS, runCommitAgents } from "$companion/demo/agentCommit";
import * as git from "$companion/demo/repo";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { DESK_ONLY_COMMANDS, LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import {
  askDeskToCommit,
  askDeskToStop,
  commitAgentArgs,
  followAgentCommit,
  resetAgentCommits,
} from "$companion/state/agentCommit";
import { launchTables, loadLaunchTables } from "$companion/state/sessions";
import { connectWorkstation, openTerminal, view as phoneView } from "$companion/state/workstation";
import { agentCommitControl, changeSections } from "$companion/surfaces/phoneGit";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { allowedToRemoteRole, tableSize } from "$companion/testing/remoteTable";
import { argsOf, mark } from "$companion/testing/wire";

const WS = DEMO.atlas;
const ROOT = DEMO.atlasRoot;

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  disconnectChannel();
  gitStore.set({});
  resetAgentCommits();
  resetDesktopStores();
});

/// A visit with the Git surface open on atlas-api: what PhoneGit.svelte
/// does when it is drawn.
async function openGit(): Promise<DemoWorkstation> {
  const demo = createDemoWorkstation();
  stops.push(await connectWorkstation(loopback(demo), deviceStorage()));
  await settle();
  ensureGitView(WS, ROOT);
  await refresh(WS);
  stops.push(await startWatching(WS));
  stops.push(followAgentCommit(WS));
  await loadLaunchTables();
  await settle();
  return demo;
}

function gitView(): GitViewState {
  return get(gitStore)[WS];
}

/// The row as the screen draws it, at `now`.
function control(now = Date.now()) {
  const args = commitAgentArgs(
    get(launchTables),
    get(trustedAgentConfigs)(WS),
    get(agentProfilesStore),
    get(agentModelDefaultsStore),
    get(agentDefaultsStore).defaultAgent
  );
  return agentCommitControl(gitView(), args, now);
}

function changes(): number {
  return changeSections(gitView()).reduce((n, section) => n + section.total, 0);
}

function deskRun(demo: DemoWorkstation) {
  return demo.state.workspaces.workspaces.find((w) => w.id === WS)?.gitView?.agentCommit;
}

/// Time passing at the desk until its commit agent has finished.
async function deskFinishes(demo: DemoWorkstation): Promise<void> {
  runCommitAgents(demo);
  await settle();
  runCommitAgents(demo);
  await settle();
}

describe("the button", () => {
  it("is offered over a dirty tree once the Workstation's agent is known", async () => {
    await openGit();
    expect(changes()).toBe(3);
    expect(control()).toMatchObject({ shows: "button", label: "Commit via agent", blocker: null });
  });
});

describe("a run the phone asks for", () => {
  it("runs at the Workstation, is drawn from the desk's record, and the Changes list empties", async () => {
    const demo = await openGit();
    const from = mark(demo);

    await askDeskToCommit(WS);
    await settle();

    expect(argsOf(demo, "agent_commit_for_device", from)).toEqual([{ workspaceId: WS, action: "start", cwd: ROOT }]);
    // The desk's run, written down where the desk keeps it...
    const run = deskRun(demo);
    expect(run).toMatchObject({ cwd: ROOT, retries: 0 });
    // ...and drawn on the phone from that record.
    expect(gitView().agentCommit).toEqual({ sessionId: run!.sessionId, startedAt: run!.startedAt, stopping: false });
    expect(control(run!.startedAt! + 12_000)).toMatchObject({
      shows: "running",
      label: "Committing…",
      elapsed: "12s",
      canShow: true,
      canStop: true,
      session: run!.sessionId,
    });
    // Hidden at the desk: no page holds it.
    const atlas = demo.state.workspaces.workspaces.find((w) => w.id === WS)!;
    expect(JSON.stringify(atlas.pages)).not.toContain(run!.sessionId);

    await deskFinishes(demo);

    expect(deskRun(demo)).toBeUndefined();
    expect(changes()).toBe(0);
    expect(agentCommitPhase(gitView())).toBe("done");
    expect(control()).toMatchObject({ shows: "done", label: "Committed" });
    expect(gitView().error).toBeNull();
    const repo = demo.state.repos[ROOT];
    expect(repo.commits[git.headSha(repo)].message).toBe("Update src/auth, test");
  });

  it("opens the agent's session in the phone's terminal", async () => {
    const demo = await openGit();
    await askDeskToCommit(WS);
    await settle();
    const session = deskRun(demo)!.sessionId;

    openTerminal(session);
    expect(get(phoneView)).toMatchObject({ workspaceId: WS, sessionId: session });
  });

  it("stops through the desk, never with a kill of its own, and says so", async () => {
    const demo = await openGit();
    await askDeskToCommit(WS);
    await settle();
    const session = deskRun(demo)!.sessionId;
    const from = mark(demo);

    await askDeskToStop(WS);
    await settle();

    expect(argsOf(demo, "agent_commit_for_device", from)).toEqual([
      { workspaceId: WS, action: "stop", sessionId: session },
    ]);
    expect(demo.commands().slice(from)).not.toContain("kill_session");
    expect(deskRun(demo)).toBeUndefined();
    expect(agentCommitPhase(gitView())).toBe("idle");
    expect(gitView().error).toBe("Commit via agent stopped");
    expect(changes()).toBe(3);
  });

  it("says the desk's refusal on the phone", async () => {
    const demo = await openGit();
    await askDeskToCommit(WS);
    await settle();

    await askDeskToCommit(WS);
    expect(gitView().error).toBe("A commit agent is already running");
    expect(demo.state.sessions.filter((s) => s.id === deskRun(demo)!.sessionId)).toHaveLength(1);

    await deskFinishes(demo);
    // Pressed anyway -- the button says why it is off, but the desk is
    // the one that decides.
    await askDeskToCommit(WS);
    expect(gitView().error).toBe("Nothing to commit");
  });

  it("asks nothing the Workstation cannot answer, nothing a Device may not, and nothing of the desk's layout", async () => {
    const demo = await openGit();
    await askDeskToCommit(WS);
    await settle();
    await askDeskToStop(WS);
    await settle();
    await askDeskToCommit(WS);
    await settle();
    await deskFinishes(demo);

    const sent = demo.commands();
    const refused = [...LAYOUT_SAVING_COMMANDS, ...DESK_ONLY_COMMANDS] as readonly string[];
    expect(sent.filter((cmd) => refused.includes(cmd))).toEqual([]);
    expect(tableSize()).toBeGreaterThan(100);
    expect([...new Set(sent)].filter((cmd) => !allowedToRemoteRole(cmd))).toEqual([]);
    expect(demo.unanswered()).toEqual([]);
  });
});

describe("on the page's clock", () => {
  it("finishes as the demo's time passes, whatever else the desk did meanwhile", async () => {
    const demo = await openGit();
    await askDeskToCommit(WS);
    await settle();
    demo.advance();
    await settle();
    expect(control().shows).toBe("running");
    demo.advance();
    await settle();
    expect(deskRun(demo)).toBeUndefined();
    expect(changes()).toBe(0);
    expect(control().shows).toBe("done");
  });
});

describe("a run started at the desk", () => {
  it("is drawn on the phone the same way", async () => {
    const demo = await openGit();
    // The desk's own button, which writes the same record.
    AGENT_COMMIT_COMMANDS.agent_commit_for_device({ workspaceId: WS, action: "start", cwd: ROOT }, demo);
    await settle();

    expect(gitView().agentCommit?.sessionId).toBe(deskRun(demo)!.sessionId);
    expect(control()).toMatchObject({ shows: "running", label: "Committing…" });

    await deskFinishes(demo);
    expect(control()).toMatchObject({ shows: "done" });
    expect(get(layoutState).workspaces.find((w) => w.id === WS)?.gitView?.agentCommit).toBeUndefined();
  });
});
