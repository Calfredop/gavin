// A workspace's tool library and its standalone runs, as the Demo
// Workstation answers them: the rows the daemon stores (`get_tools`), the
// last run of each (`tool_runs`), and the two writes a launch makes --
// the run filed (`start_tool_run`) and an agent tool's verdict
// (`set_tool_run_outcome`).
//
// The daemon closes a command or a script tool's run itself, off the
// session's exit. The demo plays that as time passes (`finishToolRuns`):
// the shell prints, the run is filed `passed`, and then the session ends
// -- in that order, so whoever reads the runs again on the exit reads
// the verdict. Editing the library is the desk's, and a phone sends none.
import type { ToolRecord } from "$lib/orchestration/orchestrationTools";
import type { ToolRun } from "$lib/workspace/workspaceTools";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import { DEMO } from "$companion/demo/sampleData";
import { end, write } from "$companion/demo/sessions";

/// A run, and the workspace it was run in: the daemon keeps runs per
/// workspace, and answers one workspace's at a time.
export interface DemoToolRun extends ToolRun {
  workspaceId: string;
}

const HOUR = 3600;

/// The library: atlas-api's own three, and one every workspace has.
export function sampleTools(): ToolRecord[] {
  const tool = (over: Partial<ToolRecord> & Pick<ToolRecord, "id" | "name" | "kind" | "body">): ToolRecord => ({
    workspaceId: DEMO.atlas,
    description: "",
    params: [],
    position: 0,
    cwd: null,
    icon: null,
    ...over,
  });
  return [
    tool({
      id: "demo-tool-lint",
      name: "Lint",
      description: "Checks the service's code style",
      kind: "command",
      body: "npm run lint",
      position: 0,
    }),
    tool({
      id: "demo-tool-deploy",
      name: "Deploy to staging",
      description: "Builds a branch and ships it to the staging cluster",
      kind: "script",
      body: "set -e\nnpm run build\n./scripts/deploy.sh staging {{branch}}",
      params: [{ name: "branch", label: "Branch", default: "main" }],
      position: 1,
    }),
    tool({
      id: "demo-tool-changelog",
      name: "Draft the changelog",
      description: "Asks the agent for release notes since a tag",
      kind: "agent",
      body: "Read the commits since {{since}} and draft this release's changelog entry. Change no files.",
      params: [{ name: "since", label: "Since tag", default: "v1.4.0" }],
      position: 2,
    }),
    tool({
      id: "demo-tool-disk",
      workspaceId: null,
      name: "Disk space",
      description: "How full the Workstation's disks are",
      kind: "command",
      body: "df -h",
      position: 3,
    }),
  ];
}

/// What has been run already: Lint passed this morning, the deploy broke
/// yesterday.
export function sampleToolRuns(nowSec: number): DemoToolRun[] {
  return [
    {
      id: 1,
      workspaceId: DEMO.atlas,
      toolId: "demo-tool-lint",
      sessionId: "s-demo-tool-lint",
      command: "npm run lint",
      launchCwd: DEMO.atlasRoot,
      conversationId: null,
      startedAt: nowSec - 3 * HOUR,
      endedAt: nowSec - 3 * HOUR + 12,
      exitCode: 0,
      outcome: "passed",
    },
    {
      id: 2,
      workspaceId: DEMO.atlas,
      toolId: "demo-tool-deploy",
      sessionId: "s-demo-tool-deploy",
      command: "./scripts/deploy.sh staging main",
      launchCwd: DEMO.atlasRoot,
      conversationId: null,
      startedAt: nowSec - 26 * HOUR,
      endedAt: nowSec - 26 * HOUR + 95,
      exitCode: 1,
      outcome: "failed",
    },
  ];
}

function workspaceOf(args: Record<string, unknown>, demo: DemoContext): string {
  const id = text(args, "workspaceId");
  if (!demo.state.workspaces.workspaces.some((w) => w.id === id)) {
    throw new DemoFailure(`the Demo Workstation has no workspace ${JSON.stringify(id)}`);
  }
  return id;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/// The kind of the tool a run ran, or null for one no longer stored --
/// a built-in, which the daemon does not store either.
function kindOf(demo: DemoContext, toolId: string): ToolRecord["kind"] | null {
  return demo.state.tools.find((t) => t.id === toolId)?.kind ?? null;
}

function shellRun(demo: DemoContext, run: DemoToolRun): boolean {
  if (run.outcome !== "running") return false;
  const kind = kindOf(demo, run.toolId);
  if (kind === "command" || kind === "script") return true;
  // A built-in shell tool: its command line is the epilogue the desk's
  // builder adds to every shell tool, which no agent's launch has.
  return kind === null && (run.command ?? "").includes("__gavin_code");
}

export const TOOL_COMMANDS: Record<string, DemoCommand> = {
  // This workspace's rows and every global one, as the daemon answers.
  get_tools: (args, demo): Answer<"getTools"> => {
    const id = workspaceOf(args, demo);
    return demo.state.tools.filter((t) => t.workspaceId === id || t.workspaceId === null);
  },
  // The LAST run of each tool, not a history.
  tool_runs: (args, demo): Answer<"toolRuns"> => {
    const id = workspaceOf(args, demo);
    const last = new Map<string, DemoToolRun>();
    for (const run of demo.state.toolRuns) {
      if (run.workspaceId !== id) continue;
      const held = last.get(run.toolId);
      if (!held || run.id > held.id) last.set(run.toolId, run);
    }
    return [...last.values()].map(({ workspaceId: _ws, ...run }) => run);
  },
  start_tool_run: (args, demo): Answer<"startToolRun"> => {
    const workspaceId = workspaceOf(args, demo);
    const sessionId = text(args, "sessionId");
    const run: DemoToolRun = {
      id: Math.max(0, ...demo.state.toolRuns.map((r) => r.id)) + 1,
      workspaceId,
      toolId: text(args, "toolId"),
      sessionId,
      command: typeof args.command === "string" ? args.command : null,
      launchCwd: typeof args.launchCwd === "string" ? args.launchCwd : null,
      conversationId: typeof args.conversationId === "string" ? args.conversationId : null,
      startedAt: nowSec(),
      endedAt: null,
      exitCode: null,
      outcome: "running",
    };
    demo.state.toolRuns.push(run);
    // A shell tool's first words. Its terminal began as the demo's agent
    // screen, which knows no command it was not scripted for.
    if (shellRun(demo, run) && demo.state.terminals[sessionId]) {
      demo.state.terminals[sessionId] = {
        output: "",
        program: { kind: "shell", cwd: run.launchCwd ?? DEMO.home, line: "" },
      };
      write(demo, sessionId, `\x1b[H\x1b[2J$ ${(run.command ?? "").split("\n")[0]}\r\n`);
    }
  },
  // Only a run still open takes a verdict: a second write is refused by
  // the daemon's guard, and changes nothing here either.
  set_tool_run_outcome: (args, demo): Answer<"setToolRunOutcome"> => {
    const sessionId = text(args, "sessionId");
    const run = demo.state.toolRuns.find((r) => r.sessionId === sessionId && r.outcome === "running");
    if (!run) return;
    run.outcome = text(args, "outcome");
    run.exitCode = typeof args.exitCode === "number" ? args.exitCode : null;
    run.endedAt = nowSec();
  },
};

/// The shell tools still running finish: each prints its last line, its
/// run is filed as passed, and its session exits.
export function finishToolRuns(demo: DemoContext): void {
  for (const run of demo.state.toolRuns) {
    if (!shellRun(demo, run)) continue;
    write(demo, run.sessionId, "Done. This is the Demo Workstation: nothing was run.\r\n");
    run.outcome = "passed";
    run.exitCode = 0;
    run.endedAt = nowSec();
    if (demo.state.terminals[run.sessionId]) end(demo, run.sessionId);
  }
}
