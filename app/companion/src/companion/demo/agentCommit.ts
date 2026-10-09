// The desk's half of a Device's "Commit via agent", as the Demo
// Workstation plays it.
//
// On a Workstation the phone only asks, and the desk window that runs the
// workspace runs its own commit (`$lib/companion/deviceCommit`): a hidden
// headless agent that stages and commits the tree, written down in the
// workspace's Git prefs (`gitView.agentCommit`) until it exits. So the
// demo plays that desk: it refuses what the desk refuses, in the desk's
// words; starts a hidden agent no page holds; writes the record and says
// so (`workspaces-synced`); and as time passes (`advance`) the agent reads
// the changes, commits them all in one commit, never pushes, and exits --
// and the record goes. A Stop ends it with nothing committed.
import type { AgentCommitRecord, Workspace } from "$lib/core/workspace";
import { DemoFailure, text, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import * as git from "$companion/demo/repo";
import { end, launch, setStatus, write, type DemoTerminal } from "$companion/demo/sessions";
import { rows, said, working } from "$companion/demo/transcripts";
import { announceFiles, announceRepo, repoHolding } from "$companion/demo/watches";

/// The headless run as its terminal's first line shows it.
const COMMAND = "claude -p 'Commit the uncommitted work in this checkout.…'";

/// Commit agents that have read their changes, and commit on the next
/// step.
const read = new WeakSet<DemoTerminal>();

function workspaceOf(demo: DemoContext, id: unknown): Workspace {
  const ws = demo.state.workspaces.workspaces.find((w) => w.id === id);
  if (!ws) throw new DemoFailure("This workspace is no longer on the Workstation");
  return ws;
}

/// Writes the workspace's record of its commit run, or clears it, and
/// says so as the desk's save does.
function record(demo: DemoContext, workspaceId: string, run: AgentCommitRecord | undefined): void {
  const data = demo.state.workspaces;
  demo.state.workspaces = {
    ...data,
    workspaces: data.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      const { agentCommit: _, ...prefs } = w.gitView ?? {};
      return { ...w, gitView: run ? { ...prefs, agentCommit: run } : prefs };
    }),
  };
  demo.emit("workspaces-synced", { origin: "main", data: demo.state.workspaces });
}

function changed(demo: DemoContext, repo: git.DemoRepo): string[] {
  const status = git.status(repo, demo.state.files);
  return [...new Set([...status.staged, ...status.unstaged].map((e) => e.path))];
}

/// What the agent calls its one commit: the folders it touches.
function subject(paths: string[]): string {
  const folders = [...new Set(paths.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "the root")))].sort();
  return `Update ${folders.slice(0, 3).join(", ")}${folders.length > 3 ? " and more" : ""}`;
}

function start(args: Record<string, unknown>, demo: DemoContext): { sessionId: string; startedAt: number } {
  const ws = workspaceOf(demo, args.workspaceId);
  const cwd = text(args, "cwd");
  const repo = repoHolding(demo, cwd);
  if (!repo) throw new DemoFailure("No repository");
  if (ws.gitView?.agentCommit) throw new DemoFailure("A commit agent is already running");
  if (changed(demo, repo).length === 0) throw new DemoFailure("Nothing to commit");
  // Hidden: on no page, as the desk's commit run is.
  const sessionId = launch(demo, { cwd, command: COMMAND, place: () => {} });
  demo.state.terminals[sessionId] = {
    output: rows(`✻ ${COMMAND}`, "", ...said("Reading what changed in this checkout."), "", working("Committing", "1s")),
    program: { kind: "agent", ask: { kind: "working" }, line: "", reply: null },
  };
  setStatus(demo, sessionId, "working");
  const startedAt = Date.now();
  record(demo, ws.id, { sessionId, cwd, retries: 0, startedAt });
  return { sessionId, startedAt };
}

function stop(args: Record<string, unknown>, demo: DemoContext): null {
  const ws = workspaceOf(demo, args.workspaceId);
  const sessionId = text(args, "sessionId");
  if (ws.gitView?.agentCommit?.sessionId !== sessionId) {
    throw new DemoFailure("That commit agent is not running at the desk");
  }
  write(demo, sessionId, rows("", "  ⎿  Interrupted by user"));
  end(demo, sessionId);
  record(demo, ws.id, undefined);
  return null;
}

export const AGENT_COMMIT_COMMANDS: Record<string, DemoCommand> = {
  agent_commit_for_device: (args, demo) => {
    if (args.action === "start") return start(args, demo);
    if (args.action === "stop") return stop(args, demo);
    throw new DemoFailure(`not a commit request: ${String(args.action)}`);
  },
};

/// Time passing at the desk: each commit agent takes its next step. The
/// first reads the changes; the second commits them, says what it did and
/// exits, and the run's record goes.
export function runCommitAgents(demo: DemoContext): void {
  for (const ws of demo.state.workspaces.workspaces) {
    const run = ws.gitView?.agentCommit;
    const terminal = run ? demo.state.terminals[run.sessionId] : undefined;
    if (!run || !terminal) continue;
    const repo = repoHolding(demo, run.cwd);
    const paths = repo ? changed(demo, repo) : [];
    if (!read.has(terminal) && paths.length > 0) {
      read.add(terminal);
      const count = `${paths.length} file${paths.length === 1 ? "" : "s"}`;
      write(demo, run.sessionId, rows("", ...said(`${count} changed. One commit: ${subject(paths)}.`)));
      continue;
    }
    if (repo && paths.length > 0) {
      const before = { ...demo.state.files };
      git.stageAll(repo, demo.state.files);
      git.commit(repo, subject(paths), false);
      announceFiles(demo, before);
      announceRepo(demo, repo);
      write(demo, run.sessionId, rows("", ...said(`Committed ${git.short(git.headSha(repo))} ${subject(paths)}. Nothing was pushed.`)));
    } else {
      write(demo, run.sessionId, rows("", ...said("Nothing is left to commit.")));
    }
    end(demo, run.sessionId);
    record(demo, ws.id, undefined);
  }
}
