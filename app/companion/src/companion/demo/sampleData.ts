// What the Demo Workstation holds: a small, believable machine.
//
// Typed against the DESKTOP's own wire types, deliberately. The demo is
// the suites' fixture as well as the thing App Review explores, and a
// sample that drifts from a shape the desktop reads fails the type check
// here rather than rendering as a blank card on somebody's phone.
//
// Two real projects and a Scratchpad, chosen so the first surfaces have
// every case to draw: a plan with nested tasks, a card an agent is
// waiting on a human about, a status no column matches, a second context,
// a rail in mid-run and one waiting to be started, and a workspace with
// no root at all. The cards are files (sampleCards.ts), and the trees
// are what a scan of them reads; the two projects' other files and their
// Git histories are sampleProjects.ts.
import type { LaunchConfig } from "$lib/agents/launchGate";
import type { QueuedInput } from "$lib/agents/queuedInput";
import type { SessionBaseline } from "$lib/core/backend";
import type { Board } from "$lib/board/kanban";
import type { AgentDefaults } from "$lib/cards/complexity";
import type { GavinContext, GavinTree } from "$lib/core/gavin";
import type { Workspace, WorkspacesData } from "$lib/core/workspace";
import type { Orchestration } from "$lib/orchestration/orchestration";
import { scanPlans } from "$companion/demo/cardFiles";
import type { DemoRepo } from "$companion/demo/repo";
import { sampleCardFiles } from "$companion/demo/sampleCards";
import { projectFiles, sampleRepos } from "$companion/demo/sampleProjects";
import type { DemoTerminal } from "$companion/demo/sessions";
import { sampleTerminals } from "$companion/demo/transcripts";

export const DEMO = {
  workstation: { id: "demo", name: "Demo Workstation", demo: true },
  atlas: "demo-atlas",
  atlasRoot: "/Users/demo/code/atlas-api",
  notes: "demo-notes",
  notesRoot: "/Users/demo/code/field-notes",
  scratch: "demo-scratch",
  home: "/Users/demo",
  /// A project on the demo's disk that no workspace works in yet: what
  /// adding a workspace from the phone finds.
  weatherRoot: "/Users/demo/code/weather-station",
} as const;

/// The Workstation's app-wide settings, as config.json holds them: null
/// is "nobody chose", which inherits gavin's own default.
export interface DemoSettings {
  theme: string | null;
  terminalFontSize: number | null;
  autoCommit: boolean | null;
  requireReview: boolean | null;
  gitTracking: boolean | null;
  headroom: boolean | null;
  customResumeArgs: string | null;
  agentModels: Record<string, string>;
  agentDefaults: AgentDefaults;
  launch: LaunchConfig | null;
}

/// Everything a Demo Workstation can be asked about, and the only thing
/// its commands read. Mutable: the demo's activity script and its write
/// commands change it in place, and every answer is a copy.
export interface DemoState {
  workspaces: WorkspacesData;
  trees: Record<string, GavinTree>;
  boards: Record<string, Board>;
  orchestrations: Record<string, Orchestration>;
  sessions: SessionBaseline[];
  sessionNames: Record<string, string>;
  /// The machine's disk: every file, by absolute path. What the Files
  /// surface lists and the editor reads and writes, each repository's
  /// working tree (sampleProjects.ts), every card file the trees are
  /// scanned from (cardFiles.ts), and each project's PRD.
  files: Record<string, string>;
  /// The Git repositories, by root.
  repos: Record<string, DemoRepo>;
  /// What is being watched, and by how many: a desk reports a file's or a
  /// checkout's changes only while something watches it.
  watches: { files: Record<string, number>; git: Record<string, number> };
  /// Follow-ups waiting for an agent that was busy when they came.
  queuedInputs: QueuedInput[];
  /// Every live session's terminal: what it has written, and what it
  /// does with what is typed into it (sessions.ts).
  terminals: Record<string, DemoTerminal>;
  /// How many sessions have been opened on the demo, which is what
  /// names the next one.
  launched: number;
  settings: DemoSettings;
}

function session(id: string, cwd: string, status: string): SessionBaseline {
  return { id, cwd, status, restored: false, interrupted: false, orphan: null, failureReason: null };
}

/// A context as the daemon reports it, its cards read off `files`.
function context(
  folderPath: string,
  kind: GavinContext["kind"],
  name: string,
  files: Record<string, string>
): GavinContext {
  return {
    folderPath,
    kind,
    name,
    plans: scanPlans({ folderPath, kind }, files),
    docs: [],
    specs: [],
    hasPrd: kind === "root",
    configWarning: false,
    agent: kind === "root" ? { profile: "claude-code", file: "CLAUDE.md", command: null } : null,
    prd: null,
  };
}

/// The tree the daemon reports for a folder gavin was just set up in: its
/// root context and no cards yet. A folder gavin is not in reports none.
export function freshTree(root: string, name: string, scaffolded: boolean): GavinTree {
  return { rootPath: root, rootMissing: false, contexts: scaffolded ? [context(root, "root", name, {})] : [] };
}

function atlasTree(files: Record<string, string>): GavinTree {
  const root = DEMO.atlasRoot;
  return {
    rootPath: root,
    rootMissing: false,
    contexts: [
      context(root, "root", "atlas-api", files),
      context(`${root}/services/billing`, "context", "billing", files),
    ],
  };
}

function notesTree(files: Record<string, string>): GavinTree {
  return {
    rootPath: DEMO.notesRoot,
    rootMissing: false,
    contexts: [context(DEMO.notesRoot, "root", "field-notes", files)],
  };
}

function workspaces(): Workspace[] {
  return [
    {
      id: DEMO.atlas,
      name: "atlas-api",
      rootPath: DEMO.atlasRoot,
      color: "#2dd4bf",
      mainSessionId: "s-atlas-main",
      activePageId: "p-atlas-auth",
      lastActiveAt: 1_790_000_300_000,
      /// A workspace-local custom the phone's Agents → Customs tab can edit.
      customProfiles: [
        {
          id: "local:atlas-helper",
          label: "Atlas helper",
          command: "atlas-helper",
          modelFlag: "--llm",
          apiFamily: "anthropic",
        },
      ],
      pages: [
        {
          id: "p-atlas-auth",
          name: "auth",
          focusedSessionId: "s-atlas-auth",
          layout: { type: "leaf", tabs: ["s-atlas-auth", "s-atlas-store"], activeTabIndex: 0 },
        },
        {
          id: "p-atlas-billing",
          name: "billing",
          focusedSessionId: "s-atlas-billing",
          layout: { type: "leaf", tabs: ["s-atlas-billing"], activeTabIndex: 0 },
        },
      ],
    },
    {
      id: DEMO.notes,
      name: "field-notes",
      rootPath: DEMO.notesRoot,
      color: "#a78bfa",
      activePageId: "p-notes-sync",
      lastActiveAt: 1_790_000_100_000,
      pages: [
        {
          id: "p-notes-sync",
          name: "sync",
          focusedSessionId: "s-notes-sync",
          layout: { type: "leaf", tabs: ["s-notes-sync"], activeTabIndex: 0 },
        },
      ],
    },
    {
      // No root: a workspace the human never pointed at a folder. It has
      // terminals and nothing else, so it has no board to show.
      id: DEMO.scratch,
      name: "Scratchpad",
      activePageId: "p-scratch",
      pages: [
        {
          id: "p-scratch",
          name: "shell",
          focusedSessionId: "s-scratch",
          layout: { type: "leaf", tabs: ["s-scratch"], activeTabIndex: 0 },
        },
      ],
    },
  ];
}

function boards(atlas: GavinTree): Record<string, Board> {
  const find = (fileName: string): string => {
    for (const ctx of atlas.contexts) {
      const plan = ctx.plans.find((p) => p.fileName === fileName);
      if (plan) return plan.path;
    }
    throw new Error(`the demo has no card ${fileName}`);
  };
  return {
    [DEMO.atlas]: {
      columns: [
        { id: "col-todo", name: "To Do", position: 0 },
        { id: "col-progress", name: "In Progress", position: 1 },
        { id: "col-review", name: "Review", position: 2 },
        { id: "col-done", name: "Done", position: 3 },
      ],
      labels: [
        { id: "l-backend", name: "backend", color: "#60a5fa" },
        { id: "l-bug", name: "bug", color: "#f87171" },
        { id: "l-security", name: "security", color: "#fb923c" },
        { id: "l-docs", name: "docs", color: "#a78bfa" },
        { id: "l-billing", name: "billing", color: "#fbbf24" },
      ],
      cardSessions: [
        { path: find("token-refresh.md"), sessionId: "s-atlas-auth", cwd: DEMO.atlasRoot },
        { path: find("session-store.md"), sessionId: "s-atlas-store", cwd: DEMO.atlasRoot },
        {
          path: find("invoice-pdf.md"),
          sessionId: "s-atlas-billing",
          cwd: `${DEMO.atlasRoot}/services/billing`,
        },
      ],
    },
    [DEMO.notes]: {
      columns: [
        { id: "col-todo", name: "To Do", position: 0 },
        { id: "col-progress", name: "In Progress", position: 1 },
        { id: "col-done", name: "Done", position: 2 },
      ],
      labels: [{ id: "l-ui", name: "ui", color: "#f472b6" }],
      cardSessions: [
        {
          path: `${DEMO.notesRoot}/.gavin-root/plans/offline-sync.md`,
          sessionId: "s-notes-sync",
          cwd: DEMO.notesRoot,
        },
      ],
    },
    // A board exists for every workspace, rooted or not: the columns are
    // the daemon's, and only the cards need a folder to live in.
    [DEMO.scratch]: {
      columns: [
        { id: "col-todo", name: "To Do", position: 0 },
        { id: "col-progress", name: "In Progress", position: 1 },
        { id: "col-done", name: "Done", position: 2 },
      ],
      labels: [],
      cardSessions: [],
    },
  };
}

function orchestrations(): Record<string, Orchestration> {
  const plans = `${DEMO.atlasRoot}/.gavin-root/plans`;
  return {
    [DEMO.atlas]: {
      rails: [
        {
          id: "rail-auth",
          name: "auth",
          position: 0,
          worktreePath: null,
          branch: null,
          pageId: "p-atlas-auth",
          stages: [
            {
              id: "stage-auth-1",
              position: 0,
              steps: [{ id: "step-token-refresh", position: 0, cardPath: `${plans}/token-refresh.md` }],
            },
            {
              id: "stage-auth-2",
              position: 1,
              steps: [{ id: "step-rate-limit", position: 0, cardPath: `${plans}/login-rate-limit.md` }],
            },
          ],
        },
        {
          // Idle, with work on it: the rail a phone is picked up to start.
          id: "rail-fixes",
          name: "fixes",
          position: 1,
          worktreePath: null,
          branch: null,
          pageId: null,
          stages: [
            {
              id: "stage-fixes-1",
              position: 0,
              steps: [{ id: "step-flaky-expiry", position: 0, cardPath: `${plans}/flaky-expiry-test.md` }],
            },
            {
              id: "stage-fixes-2",
              position: 1,
              steps: [
                {
                  id: "step-proration",
                  position: 0,
                  cardPath: `${DEMO.atlasRoot}/services/billing/.gavin/plans/proration.md`,
                },
              ],
            },
          ],
        },
      ],
      conflictNotes: [],
      railRuns: [{ railId: "rail-auth", state: "running", currentStageId: "stage-auth-1" }],
      stepRuns: [
        { stepId: "step-token-refresh", state: "running", sessionId: "s-atlas-auth", reason: null },
      ],
    },
    [DEMO.notes]: { rails: [], conflictNotes: [], railRuns: [], stepRuns: [] },
    [DEMO.scratch]: { rails: [], conflictNotes: [], railRuns: [], stepRuns: [] },
  };
}

/// The rest of the demo's home folder: a project nobody has made a
/// workspace of, a document, and the dotfile every home folder has.
function homeFiles(): Record<string, string> {
  const weather = DEMO.weatherRoot;
  return {
    [`${DEMO.home}/.zshrc`]: "export EDITOR=vim\n",
    [`${DEMO.home}/Documents/packing-list.md`]: "# Packing list\n\n- charger\n- notebook\n",
    [`${weather}/.gitignore`]: "/target\n",
    [`${weather}/Cargo.toml`]: '[package]\nname = "weather-station"\nversion = "0.1.0"\nedition = "2021"\n',
    [`${weather}/README.md`]: "# weather-station\n\nReads the rooftop sensors and keeps a week of readings.\n",
    [`${weather}/src/main.rs`]: 'fn main() {\n    println!("reading the sensors");\n}\n',
  };
}

export function sampleSettings(): DemoSettings {
  return {
    theme: null,
    terminalFontSize: null,
    autoCommit: null,
    requireReview: null,
    gitTracking: null,
    headroom: null,
    customResumeArgs: null,
    agentModels: {},
    agentDefaults: {
      defaultAgent: "claude-code",
      customProfiles: [
        {
          id: "demo-cli",
          label: "Demo CLI",
          command: "demo-agent",
          modelFlag: "--model",
          effortFlag: "--effort",
          apiFamily: "openai",
        },
      ],
      complexityTables: {},
      pauseCycles: {},
      promptExtras: {},
      extraCliArgs: {},
      fallbackChains: {},
      fallbackThresholds: {},
      actionPromptOverrides: {},
    },
    launch: null,
  };
}

/// Each repository with the cards under its root committed, in every
/// commit and the index: a gavin project tracks its `.gavin-root`, so the
/// cards the demo opens on are clean, and one the phone writes is a
/// change on the Git surface. Copies, never edits: commits share trees.
function trackingCards(repos: Record<string, DemoRepo>, cards: Record<string, string>): Record<string, DemoRepo> {
  return Object.fromEntries(
    Object.entries(repos).map(([root, repo]) => {
      const mine = Object.fromEntries(
        Object.entries(cards)
          .filter(([path]) => path.startsWith(`${root}/`))
          .map(([path, content]) => [path.slice(root.length + 1), content])
      );
      const commits = Object.fromEntries(
        Object.entries(repo.commits).map(([sha, commit]) => [sha, { ...commit, tree: { ...commit.tree, ...mine } }])
      );
      return [root, { ...repo, commits, index: { ...repo.index, ...mine } }];
    })
  );
}

export function sampleState(): DemoState {
  const roots = { atlas: DEMO.atlasRoot, notes: DEMO.notesRoot };
  const cards = sampleCardFiles(roots);
  const files = { ...projectFiles(roots), ...homeFiles(), ...cards };
  const trees = { [DEMO.atlas]: atlasTree(files), [DEMO.notes]: notesTree(files) };
  return {
    workspaces: { workspaces: workspaces(), activeWorkspaceId: DEMO.atlas, removedWorkspaces: [] },
    trees,
    boards: boards(trees[DEMO.atlas]),
    orchestrations: orchestrations(),
    sessions: [
      session("s-atlas-main", DEMO.atlasRoot, "idle"),
      session("s-atlas-auth", DEMO.atlasRoot, "working"),
      session("s-atlas-store", DEMO.atlasRoot, "waiting_for_input"),
      session("s-atlas-billing", `${DEMO.atlasRoot}/services/billing`, "idle"),
      session("s-notes-sync", DEMO.notesRoot, "working"),
      session("s-scratch", DEMO.home, "idle"),
    ],
    sessionNames: {
      "s-atlas-main": "atlas agent",
      "s-atlas-auth": "token refresh",
      "s-atlas-store": "session store",
      "s-atlas-billing": "invoice pdf",
      "s-notes-sync": "offline sync",
    },
    files,
    repos: trackingCards(sampleRepos(roots), cards),
    watches: { files: {}, git: {} },
    queuedInputs: [],
    terminals: sampleTerminals(DEMO.home),
    launched: 0,
    settings: sampleSettings(),
  };
}
