// What the Demo Workstation answers about its workspaces as Workstation
// data (ADR 0006): each one's settings, adding one, and what adding one
// from a phone needs -- a home folder to start from, whether gavin is in a
// folder already, and setting it up there.
//
// The host's rules, kept: a settings write names settings only and is
// refused whole for anything else, null clears a key, and the write is
// announced to every window as `workspace-settings-synced` with the
// workspace's whole settings record (`workspace_settings.rs`). A workspace
// is added as settings alone, given an id by the Workstation, and announced
// as `workspaces-synced`. A Device's writes are announced under
// `companion`, the origin no desk window has.
import type { Workspace } from "$lib/core/workspace";
import {
  isSettingsKey,
  settingsRecordOf,
  type WorkspaceSettingsRecord,
} from "$lib/workspace/workspaceSettings";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import { DEMO, freshTree } from "$companion/demo/sampleData";
import { DEVICE_ORIGIN } from "$companion/demo/settingsCommands";

function gavinRoot(root: string): string {
  return `${root}/.gavin-root`;
}

/// Whether gavin lives in a folder: its skeleton on the disk, or -- for the
/// sample projects, whose cards the demo keeps as trees rather than files --
/// a workspace there whose tree has a root context.
function scaffolded(demo: DemoContext, root: string): boolean {
  const base = `${gavinRoot(root)}/`;
  if (Object.keys(demo.state.files).some((path) => path.startsWith(base))) return true;
  return demo.state.workspaces.workspaces.some(
    (ws) => ws.rootPath === root && demo.state.trees[ws.id]?.contexts.some((c) => c.kind === "root")
  );
}

function isFolder(demo: DemoContext, path: string): boolean {
  const base = path.endsWith("/") ? path : `${path}/`;
  return Object.keys(demo.state.files).some((file) => file.startsWith(base));
}

/// A patch as the host checks one: an object naming settings and nothing
/// else. A layout key -- or the id -- is refused whole, never half-applied.
function settingsPatch(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const patch = args[name];
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new DemoFailure(`missing argument "${name}"`);
  }
  const stray = Object.keys(patch).find((key) => !isSettingsKey(key));
  if (stray !== undefined) throw new DemoFailure(`\`${stray}\` is not a workspace setting`);
  return patch as Record<string, unknown>;
}

function patched(ws: Workspace, patch: Record<string, unknown>): Workspace {
  const next: Record<string, unknown> = { ...ws };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (typeof next.name !== "string" || !next.name.trim()) {
    throw new DemoFailure("invalid workspace setting: a workspace needs a name");
  }
  return next as unknown as Workspace;
}

/// The tree the daemon reports for a workspace's folder, and the push that
/// tells a watcher about it.
function announceTree(demo: DemoContext, ws: Workspace): void {
  if (!ws.rootPath) return;
  demo.state.trees[ws.id] = freshTree(ws.rootPath, ws.name, scaffolded(demo, ws.rootPath));
  demo.emit("gavin-tree-changed", [ws.id, demo.state.trees[ws.id]]);
}

/// config.toml's `[agent]` keys, as the tree carries them.
const AGENT_KEYS: Record<string, string> = {
  profile: "profile",
  file: "file",
  command: "command",
  mcp_file: "mcpFile",
  mcp_format: "mcpFormat",
  model: "model",
  model_flag: "modelFlag",
  effort: "effort",
  effort_flag: "effortFlag",
};

/// An id no workspace on this Workstation has: the host mints a UUID; the
/// demo counts, so a suite can name what it made.
function newId(demo: DemoContext): string {
  const taken = new Set(demo.state.workspaces.workspaces.map((w) => w.id));
  let n = 1;
  while (taken.has(`demo-added-${n}`)) n += 1;
  return `demo-added-${n}`;
}

export const WORKSPACE_COMMANDS: Record<string, DemoCommand> = {
  get_workspace_settings: (_args, demo): Answer<"getWorkspaceSettings"> =>
    demo.state.workspaces.workspaces.map(settingsRecordOf),

  // A workspace the Workstation does not hold is a no-op, as the host's is:
  // the close that removed it is the newer word.
  set_workspace_settings: (args, demo) => {
    const id = text(args, "workspaceId");
    const patch = settingsPatch(args, "patch");
    const list = demo.state.workspaces.workspaces;
    const at = list.findIndex((w) => w.id === id);
    if (at === -1) return null;
    const next = patched(list[at], patch);
    list[at] = next;
    const record: WorkspaceSettingsRecord = settingsRecordOf(next);
    demo.emit("workspace-settings-synced", { origin: DEVICE_ORIGIN, record });
    return null;
  },

  add_workspace: (args, demo): Answer<"addWorkspace"> => {
    const settings = settingsPatch(args, "settings");
    const blank = { id: newId(demo), name: "", pages: [], activePageId: null } as Workspace;
    const ws = patched(blank, settings);
    ws.name = ws.name.trim();
    demo.state.workspaces.workspaces.push(ws);
    // The daemon keeps a board for every workspace, rooted or not; only
    // the cards need a folder.
    demo.state.boards[ws.id] = {
      columns: [
        { id: "col-todo", name: "To Do", position: 0 },
        { id: "col-progress", name: "In Progress", position: 1 },
        { id: "col-done", name: "Done", position: 2 },
      ],
      labels: [],
      cardSessions: [],
    };
    demo.state.orchestrations[ws.id] = { rails: [], conflictNotes: [], railRuns: [], stepRuns: [] };
    if (ws.rootPath) demo.state.trees[ws.id] = freshTree(ws.rootPath, ws.name, scaffolded(demo, ws.rootPath));
    demo.emit("workspaces-synced", {
      origin: DEVICE_ORIGIN,
      data: JSON.parse(JSON.stringify(demo.state.workspaces)),
    });
    return settingsRecordOf(ws);
  },

  home_dir: (): Answer<"homeDir"> => DEMO.home,

  gavin_root_exists: (args, demo): Answer<"gavinRootExists"> => scaffolded(demo, text(args, "rootPath")),

  // The skeleton, in the demo's words: the lead document and the config
  // that names the agent. Any workspace already on the folder hears its
  // new tree.
  init_gavin_root: (args, demo) => {
    const root = text(args, "rootPath");
    const name = text(args, "workspaceName");
    if (!isFolder(demo, root)) throw new DemoFailure(`${root}: No such file or directory (os error 2)`);
    demo.state.files[`${gavinRoot(root)}/PRD.md`] = `# ${name}\n\nWhat this project is for.\n`;
    demo.state.files[`${gavinRoot(root)}/config.toml`] = '[agent]\nprofile = "claude-code"\n';
    for (const ws of demo.state.workspaces.workspaces) {
      if (ws.rootPath === root) announceTree(demo, ws);
    }
    return null;
  },

  // Tracking is the repository's answer; the demo keeps no ignore rule of
  // its own, and a folder that is not a repository has nowhere to put one.
  set_gavin_git_tracking: (args, demo): Answer<"setGavinGitTracking"> => {
    const root = text(args, "root");
    const tracked = args.tracked === true;
    if (!demo.state.repos[root]) {
      return { isRepo: false, tracked: true, ignoredBy: null, gavinManaged: false, indexed: 0 };
    }
    return {
      isRepo: true,
      tracked,
      ignoredBy: tracked ? null : ".gitignore:1:/.gavin-root/",
      gavinManaged: !tracked,
      indexed: 0,
    };
  },

  // The agent's keys in the folder's config.toml, which the daemon reads
  // back into the tree and pushes to whoever watches it. "" clears a key.
  set_root_config_field: (args, demo) => {
    const root = text(args, "rootPath");
    const key = AGENT_KEYS[text(args, "key")];
    const value = text(args, "value").trim();
    if (!key) throw new DemoFailure(`\`${String(args.key)}\` is not a key gavin writes`);
    for (const ws of demo.state.workspaces.workspaces) {
      const context = demo.state.trees[ws.id]?.contexts.find((c) => c.kind === "root");
      if (ws.rootPath !== root || !context) continue;
      const agent: Record<string, unknown> = { ...(context.agent ?? { profile: null, file: null, command: null }) };
      agent[key] = value === "" ? null : value;
      context.agent = agent as unknown as typeof context.agent;
      demo.emit("gavin-tree-changed", [ws.id, demo.state.trees[ws.id]]);
    }
    return null;
  },
};
