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
// a rail in mid-run, and a workspace with no root at all.
import type { SessionBaseline } from "$lib/core/backend";
import type { Board } from "$lib/board/kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "$lib/core/gavin";
import type { Workspace, WorkspacesData } from "$lib/core/workspace";
import type { Orchestration } from "$lib/orchestration/orchestration";
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
} as const;

/// Everything a Demo Workstation can be asked about, and the only thing
/// its commands read. Mutable: the demo's activity script and, later, its
/// write commands change it in place, and every answer is a copy.
export interface DemoState {
  workspaces: WorkspacesData;
  trees: Record<string, GavinTree>;
  boards: Record<string, Board>;
  orchestrations: Record<string, Orchestration>;
  sessions: SessionBaseline[];
  sessionNames: Record<string, string>;
  /// Card bodies by path, for the viewer.
  files: Record<string, string>;
  /// Every live session's terminal: what it has written, and what it
  /// does with what is typed into it (sessions.ts).
  terminals: Record<string, DemoTerminal>;
  /// How many sessions have been opened on the demo, which is what
  /// names the next one.
  launched: number;
}

function session(id: string, cwd: string, status: string): SessionBaseline {
  return { id, cwd, status, restored: false, interrupted: false, orphan: null, failureReason: null };
}

function card(
  folder: string,
  marker: ".gavin-root" | ".gavin",
  fileName: string,
  fields: Partial<PlanFileInfo> & Pick<PlanFileInfo, "title" | "kind">
): PlanFileInfo {
  const dir = fields.status === "Done" ? "plans/done" : "plans";
  return {
    path: `${folder}/${marker}/${dir}/${fileName}`,
    fileName,
    status: null,
    priority: null,
    order: null,
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    modifiedAt: 1_790_000_000,
    attachments: [],
    complexity: null,
    agent: null,
    model: null,
    humanItems: [],
    ...fields,
  };
}

function context(
  folderPath: string,
  kind: GavinContext["kind"],
  name: string,
  plans: PlanFileInfo[]
): GavinContext {
  return {
    folderPath,
    kind,
    name,
    plans,
    docs: [],
    specs: [],
    hasPrd: kind === "root",
    configWarning: false,
    agent: kind === "root" ? { profile: "claude-code", file: "CLAUDE.md", command: null } : null,
    prd: null,
  };
}

function atlasTree(): GavinTree {
  const root = DEMO.atlasRoot;
  const billing = `${root}/services/billing`;
  return {
    rootPath: root,
    rootMissing: false,
    contexts: [
      context(root, "root", "atlas-api", [
        card(root, ".gavin-root", "token-refresh.md", {
          title: "Token refresh rework",
          kind: "plan",
          status: "In Progress",
          priority: "high",
          order: 1,
          labels: ["backend"],
          checklistDone: 3,
          checklistTotal: 7,
          complexity: "complex",
        }),
        card(root, ".gavin-root", "rotate-on-use.md", {
          title: "Rotate refresh tokens on use",
          kind: "task",
          parent: "token-refresh.md",
          order: 1,
        }),
        card(root, ".gavin-root", "revoke-family.md", {
          title: "Revoke the token family on reuse",
          kind: "task",
          parent: "token-refresh.md",
          order: 2,
        }),
        card(root, ".gavin-root", "migrate-sessions.md", {
          title: "Migrate stored sessions",
          kind: "task",
          parent: "token-refresh.md",
          order: 3,
        }),
        card(root, ".gavin-root", "session-store.md", {
          title: "Pick the session store",
          kind: "task",
          status: "In Progress",
          priority: "medium",
          order: 2,
          labels: ["backend"],
          checklistDone: 0,
          checklistTotal: 1,
          humanItems: [
            {
              kind: "decision",
              text: "Redis or Postgres for the session store?",
              done: false,
              options: ["Redis", "Postgres"],
              latest: null,
              state: "open",
              lineText: "Decision: Redis or Postgres for the session store?",
              lineIndex: 12,
            },
          ],
        }),
        card(root, ".gavin-root", "flaky-expiry-test.md", {
          title: "Fix the flaky session-expiry test",
          kind: "task",
          status: "To Do",
          priority: "urgent",
          order: 1,
          labels: ["bug"],
          complexity: "simple",
        }),
        card(root, ".gavin-root", "login-rate-limit.md", {
          title: "Rate-limit the login endpoint",
          kind: "task",
          status: "To Do",
          priority: "medium",
          order: 2,
          labels: ["backend", "security"],
          complexity: "moderate",
          attachments: ["docs/rate-limits.md"],
        }),
        card(root, ".gavin-root", "empty-state.md", {
          title: "Ask design about the empty state",
          kind: "note",
          status: "To Do",
          order: 3,
        }),
        card(root, ".gavin-root", "oauth-upgrade.md", {
          title: "Upgrade the OAuth library",
          kind: "task",
          status: "Blocked",
          priority: "low",
          labels: ["backend"],
        }),
        card(root, ".gavin-root", "openapi-accounts.md", {
          title: "OpenAPI spec for /v2/accounts",
          kind: "task",
          status: "Review",
          labels: ["docs"],
          checklistDone: 4,
          checklistTotal: 4,
        }),
        card(root, ".gavin-root", "audit-log-export.md", {
          title: "Audit log export",
          kind: "plan",
          status: "Done",
          labels: ["backend"],
          checklistDone: 6,
          checklistTotal: 6,
        }),
      ]),
      context(billing, "context", "billing", [
        card(billing, ".gavin", "invoice-pdf.md", {
          title: "Invoice PDF rendering",
          kind: "task",
          status: "In Progress",
          priority: "medium",
          labels: ["billing"],
          checklistDone: 1,
          checklistTotal: 3,
        }),
        card(billing, ".gavin", "proration.md", {
          title: "Proration on plan change",
          kind: "task",
          status: "To Do",
          labels: ["billing"],
        }),
      ]),
    ],
  };
}

function notesTree(): GavinTree {
  const root = DEMO.notesRoot;
  return {
    rootPath: root,
    rootMissing: false,
    contexts: [
      context(root, "root", "field-notes", [
        card(root, ".gavin-root", "offline-sync.md", {
          title: "Offline sync",
          kind: "plan",
          status: "In Progress",
          priority: "high",
          checklistDone: 2,
          checklistTotal: 5,
          complexity: "intricate",
        }),
        card(root, ".gavin-root", "conflict-merge.md", {
          title: "Merge conflicting edits by paragraph",
          kind: "task",
          parent: "offline-sync.md",
          order: 1,
        }),
        card(root, ".gavin-root", "photo-attachments.md", {
          title: "Photo attachments",
          kind: "task",
          status: "To Do",
          labels: ["ui"],
        }),
        card(root, ".gavin-root", "markdown-export.md", {
          title: "Export a notebook to Markdown",
          kind: "task",
          status: "Done",
          checklistDone: 2,
          checklistTotal: 2,
        }),
      ]),
    ],
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

function boards(): Record<string, Board> {
  const atlas = atlasTree();
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

export function sampleState(): DemoState {
  return {
    workspaces: { workspaces: workspaces(), activeWorkspaceId: DEMO.atlas, removedWorkspaces: [] },
    trees: { [DEMO.atlas]: atlasTree(), [DEMO.notes]: notesTree() },
    boards: boards(),
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
    files: {},
    terminals: sampleTerminals(DEMO.home),
    launched: 0,
  };
}
