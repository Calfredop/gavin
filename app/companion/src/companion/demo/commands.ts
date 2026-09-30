// What the Demo Workstation answers, command by command.
//
// Keyed by the desktop's own command names, because that is what arrives:
// the bundle runs the desktop's `backend.ts`, and a real Workstation would
// run each of these as the Tauri command of the same name (ADR 0003).
//
// Every answer is typed as what `backend.ts` says that command returns
// (`Answer<...>`), so a desktop change to a wire shape is a type error
// here rather than a demo that quietly renders nothing.
//
// The Git tab's commands and the Files tab's have tables of their own
// (gitCommands.ts, fileCommands.ts), as do the settings (settingsCommands.ts)
// and the workspaces as Workstation data (workspaceCommands.ts), gathered
// in with the rest below.
import type { GavinTree } from "$lib/core/gavin";
import { DemoFailure, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import { FILE_COMMANDS } from "$companion/demo/fileCommands";
import { GIT_COMMANDS } from "$companion/demo/gitCommands";
import { SETTINGS_COMMANDS } from "$companion/demo/settingsCommands";
import { WORKSPACE_COMMANDS } from "$companion/demo/workspaceCommands";

export { DemoFailure, type DemoCommand, type DemoContext } from "$companion/demo/answer";

function workspaceId(args: Record<string, unknown>, demo: DemoContext): string {
  const id = args.workspaceId;
  if (typeof id !== "string" || !demo.state.workspaces.workspaces.some((w) => w.id === id)) {
    throw new DemoFailure(`the Demo Workstation has no workspace ${JSON.stringify(id)}`);
  }
  return id;
}

function treeOf(id: string, demo: DemoContext): GavinTree {
  // A workspace bound to no folder: the daemon reports a missing root
  // rather than refusing, and the board draws its columns over no cards.
  return demo.state.trees[id] ?? { rootPath: "", rootMissing: true, contexts: [] };
}

// ---- The Workstation's work: what the surfaces draw -------------------

const WORK: Record<string, DemoCommand> = {
  get_workspaces_state: (_args, demo): Answer<"getWorkspacesState"> => demo.state.workspaces,
  get_bootstrap_error: (): Answer<"getBootstrapError"> => null,
  get_session_baselines: (_args, demo): Answer<"getSessionBaselines"> => ({
    sessions: demo.state.sessions,
    hosts: [],
  }),
  get_session_names: (_args, demo): Answer<"getSessionNames"> => demo.state.sessionNames,
  list_queued_inputs: (): Answer<"listQueuedInputs"> => [],

  get_board: (args, demo): Answer<"getBoard"> => demo.state.boards[workspaceId(args, demo)],
  get_orchestration: (args, demo): Answer<"getOrchestration"> =>
    demo.state.orchestrations[workspaceId(args, demo)],

  get_gavin_tree: (args, demo): Answer<"getGavinTree"> => treeOf(workspaceId(args, demo), demo),
  // Answers with nothing and then pushes, as the desktop's does: the
  // first scan of a watched root arrives as the first tree event.
  watch_gavin_root: (args, demo) => {
    const id = workspaceId(args, demo);
    demo.emit("gavin-tree-changed", [id, treeOf(id, demo)]);
    return null;
  },
  // No demo project runs a setup script in its worktrees.
  worktree_setup: (): Answer<"worktreeSetup"> => [],
};

// ---- The desk's own tables -------------------------------------------
//
// What the desktop's bootstrap reads before it draws anything: settings,
// lookup tables, which window holds what. No first surface needs most of
// them. They are answered anyway, and truthfully, because the surfaces
// that follow load them through the desktop's own modules -- and a demo
// with no answer is a surface showing its error state to a store
// reviewer. desktopBootstrap.test.ts holds this list to the real thing.

const CLAUDE_CODE: Answer<"agentProfiles">[number] = {
  id: "claude-code",
  label: "Claude Code",
  instructionsFile: "CLAUDE.md",
  command: "claude",
  mcpSupported: true,
  mcpConfigFile: ".mcp.json",
  promptArgs: "",
  headlessArgs: "-p",
  modelFlag: "--model",
  models: ["opus", "sonnet", "haiku"],
  effortFlag: "--effort",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  failurePatterns: [],
  failureCauses: [],
  sessionIdArgs: "",
  sessionIdDiscovery: "",
  resumeArgs: "",
  usageProbe: null,
};

// A second agent, so the settings that choose between agents -- the
// complexity table, the fallback chain -- have a choice to offer.
const CODEX: Answer<"agentProfiles">[number] = {
  ...CLAUDE_CODE,
  id: "codex",
  label: "Codex CLI",
  instructionsFile: "AGENTS.md",
  command: "codex",
  mcpConfigFile: ".codex/config.toml",
  headlessArgs: "exec",
  models: [],
  effortFlag: "-c model_reasoning_effort=",
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
};

const TABLES: Record<string, DemoCommand> = {
  temp_dir: (): Answer<"tempDir"> => "/tmp",
  // Null is "not probed": no banner, and no feature gated shut.
  daemon_compat: (): Answer<"daemonCompat"> => null,

  // The desk's layout, to READ. The three tab maps say which tab ids in
  // a page are a file, a board or a card rather than a terminal; the
  // demo's pages hold terminals only.
  get_file_tabs: (): Answer<"getFileTabs"> => ({}),
  get_board_tabs: (): Answer<"getBoardTabs"> => ({}),
  get_card_tabs: (): Answer<"getCardTabs"> => ({}),
  workspace_windows: (): Answer<"workspaceWindows"> => ({}),
  // The desk has one window open, and it holds the app's duties.
  app_duty: (): Answer<"appDuty"> => ({ holder: "main", windows: ["main"] }),

  agent_profiles: (): Answer<"agentProfiles"> => [CLAUDE_CODE, CODEX],
  agent_model_catalog: (): Answer<"agentModelCatalog"> => ({ codex: ["gpt-5-codex", "gpt-5"] }),
  mcp_formats: (): Answer<"mcpFormats"> => [],

  typesafe_settings: (): Answer<"typesafeSettings"> => ({
    enabled: false,
    hasKey: false,
    changeAttribution: false,
  }),
  update_settings: (): Answer<"updateSettings"> => ({
    currentVersion: "0.0.0-demo",
    endpoint: "",
    defaultEndpoint: "",
    overridden: false,
    enabled: false,
    pinned: false,
  }),

  list_managed_sessions: (_args, demo): Answer<"listManagedSessions"> => ({
    sessions: demo.state.sessions.map((s) => ({
      id: s.id,
      workspacePath: s.cwd,
      cwd: s.cwd,
      status: s.status,
      restored: s.restored,
      interrupted: s.interrupted,
      orphan: s.orphan,
      command: null,
      pid: null,
      rssBytes: 0,
      cpuTimeUs: 0,
      processCount: 0,
      sampledAtUs: 0,
    })),
    metrics: false,
  }),
  // A machine nobody measured: every gate that reads this treats an
  // unsupported sample as no reason to hold anything.
  system_memory: (): Answer<"systemMemory"> => ({
    supported: false,
    totalBytes: 0,
    freePercent: 0,
    pressureLevel: 0,
    swapUsedBytes: 0,
    sampledAtMs: 0,
  }),
  watchman_status: (): Answer<"watchmanStatus"> => null,
};

export const COMMANDS: Record<string, DemoCommand> = {
  ...WORK,
  ...TABLES,
  ...SETTINGS_COMMANDS,
  ...WORKSPACE_COMMANDS,
  ...GIT_COMMANDS,
  ...FILE_COMMANDS,
};
