// What the Demo Workstation answers to a board's and a card's commands.
//
// The same names and argument shapes `backend.ts` sends to a desk, over
// the demo's own disk (`DemoState.files`, cardFiles.ts). A write edits a
// card file; then, as a Workstation's watcher does, the trees are read
// again and every tree that changed is pushed as `gavin-tree-changed`,
// and a watched file that changed is said as `file-changed` -- so the
// phone learns of its own writes exactly as it learns of an agent's.
//
// The daemon's rules for WHERE a card lives come along: Done files a
// card under `done/`, archiving moves it to `archive/`, a plan's nested
// tasks travel with it, and whatever pointed at the old path (a card's
// session binding, a rail step) follows it.
import type { CardSessionRecord } from "$lib/board/kanban";
import type { HumanItemOutcome } from "$lib/core/gavin";
import type { QueuedInput } from "$lib/agents/queuedInput";
import {
  ARCHIVE_DIR,
  folderOf,
  homeFolder,
  isArchived,
  markerOf,
  newCardText,
  plansRootOf,
  readCard,
  withChecklistItem,
  withField,
  withHumanOutcome,
} from "$companion/demo/cardFiles";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import type { DemoRepo } from "$companion/demo/repo";
import { type as typeInto } from "$companion/demo/sessions";
import { announceFiles, announceRepo, repoHolding } from "$companion/demo/watches";

function optional(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/// The date an answer is written under, as the daemon's `today()`.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const FILE_NAME = /^[A-Za-z0-9._-]+\.md$/;

// ---- The disk, and who is told --------------------------------------

/// A card file, or the refusal the daemon gives a path it has no card at.
function card(demo: DemoContext, path: string): string {
  const content = demo.state.files[path];
  if (content === undefined || plansRootOf(path) === null) {
    throw new DemoFailure(`${path}: No such file or directory (os error 2)`);
  }
  return content;
}

/// Makes a change to the disk, then says what changed the way a
/// Workstation's watchers do (watches.ts) -- a card in a repository's
/// working tree is a change on its Git surface too.
function change(demo: DemoContext, write: () => void): void {
  const before = { ...demo.state.files };
  write();
  announceFiles(demo, before);
  const repos = new Set<DemoRepo>();
  for (const path of new Set([...Object.keys(before), ...Object.keys(demo.state.files)])) {
    if (before[path] === demo.state.files[path]) continue;
    const repo = repoHolding(demo, path);
    if (repo) repos.add(repo);
  }
  for (const repo of repos) announceRepo(demo, repo);
}

/// A card file moves, and everything that named it by path follows: its
/// session binding and any rail step carrying it, as the daemon re-keys
/// both.
function move(demo: DemoContext, from: string, to: string): void {
  if (from === to) return;
  demo.state.files[to] = demo.state.files[from];
  delete demo.state.files[from];
  for (const board of Object.values(demo.state.boards)) {
    for (const binding of board.cardSessions) if (binding.path === from) binding.path = to;
  }
  for (const orchestration of Object.values(demo.state.orchestrations)) {
    for (const rail of orchestration.rails) {
      for (const stage of rail.stages) {
        for (const step of stage.steps) if (step.cardPath === from) step.cardPath = to;
      }
    }
  }
}

/// Every card file under one `plans/`.
function plansUnder(demo: DemoContext, plansRoot: string): string[] {
  return Object.keys(demo.state.files).filter((p) => p.startsWith(`${plansRoot}/`) && p.endsWith(".md"));
}

/// The nested tasks sitting beside a plan: a task with no status whose
/// parent is the plan's file name.
function nestedIn(demo: DemoContext, path: string): string[] {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const folder = folderOf(path);
  return plansUnder(demo, plansRootOf(path)!).filter((p) => {
    if (p === path || folderOf(p) !== folder) return false;
    const info = readCard(p, demo.state.files[p]);
    return info.kind === "task" && info.parent === fileName && info.status === null;
  });
}

/// Moves a card, and the nested tasks beside it, into `folder`.
function moveWithChildren(demo: DemoContext, path: string, folder: string): string {
  if (folderOf(path) === folder) return path;
  const children = nestedIn(demo, path);
  const landed = `${folder}/${path.slice(path.lastIndexOf("/") + 1)}`;
  move(demo, path, landed);
  for (const child of children) move(demo, child, `${folder}/${child.slice(child.lastIndexOf("/") + 1)}`);
  return landed;
}

/// Files a card where its fields say it belongs (`relocate_for_status`).
/// An archived card stays in the archive, which only the human leaves.
function relocate(demo: DemoContext, path: string): string {
  if (isArchived(path)) return path;
  const plansRoot = plansRootOf(path)!;
  const info = readCard(path, demo.state.files[path]);
  const parentPath = info.parent
    ? plansUnder(demo, plansRoot).find((p) => p.endsWith(`/${info.parent}`) && !isArchived(p))
    : undefined;
  return moveWithChildren(demo, path, homeFolder(plansRoot, info, parentPath ? folderOf(parentPath) : null));
}

/// Puts cards back as they are in `fresh`, wherever they have been moved
/// to since: what the demo's activity does to the cards it scripts when
/// it comes round again (activity.ts).
export function putBack(demo: DemoContext, fresh: Record<string, string>, fileNames: readonly string[]): void {
  change(demo, () => {
    for (const fileName of fileNames) {
      const home = Object.keys(fresh).find((p) => plansRootOf(p) !== null && p.endsWith(`/${fileName}`));
      if (!home) continue;
      const now = Object.keys(demo.state.files).find(
        (p) => plansRootOf(p) === plansRootOf(home) && p.endsWith(`/${fileName}`)
      );
      if (now) move(demo, now, home);
      demo.state.files[home] = fresh[home];
    }
  });
}

/// The path a card file is at now, by its name, in any workspace.
export function cardNamed(demo: DemoContext, fileName: string): string | null {
  return Object.keys(demo.state.files).find((p) => plansRootOf(p) !== null && p.endsWith(`/${fileName}`)) ?? null;
}

// ---- Fields ---------------------------------------------------------

const CLEARABLE = ["status", "parent", "labels", "attachments", "complexity", "agent", "model", "effort"];
const PRIORITIES = ["none", "low", "medium", "high", "urgent"];
const LEVELS = ["trivial", "simple", "moderate", "complex", "intricate"];

/// The daemon's allow-list and its refusals (`set_plan_field`): this is
/// never an arbitrary-line writer.
function checkedValue(key: string, value: string): string {
  if (value === "") {
    if (!CLEARABLE.includes(key)) throw new DemoFailure(`empty value not allowed for: ${key}`);
    return value;
  }
  if (value.includes("\n")) throw new DemoFailure(`${key} must be a single line`);
  switch (key) {
    case "status":
    case "labels":
    case "attachments":
    case "agent":
    case "model":
    case "effort":
      return value;
    case "priority":
      if (!PRIORITIES.includes(value.toLowerCase())) throw new DemoFailure(`invalid priority value: ${value}`);
      return value;
    case "order":
      if (!/^-?\d+$/.test(value.trim())) throw new DemoFailure(`order must be an integer: ${value}`);
      return value;
    case "title":
      if (!value.trim()) throw new DemoFailure("title must be a non-empty single line");
      return value;
    case "kind":
      if (!["note", "task", "plan"].includes(value)) throw new DemoFailure(`invalid kind value: ${value}`);
      return value;
    case "parent":
      if (!FILE_NAME.test(value)) throw new DemoFailure(`parent must match [A-Za-z0-9._-]+.md, got: ${value}`);
      return value;
    case "complexity": {
      const level = value.trim().toLowerCase();
      if (!LEVELS.includes(level)) throw new DemoFailure(`invalid complexity value: ${value}`);
      return level;
    }
    default:
      throw new DemoFailure(`field not allowed: ${key}`);
  }
}

// ---- The commands ---------------------------------------------------

// The viewer's reads and watches of a card or a PRD are the Files tab's
// commands (fileCommands.ts): one disk, one table of who watches it.
export const CARD_COMMANDS: Record<string, DemoCommand> = {
  set_plan_frontmatter_field: (args, demo): Answer<"setPlanFrontmatterField"> => {
    const path = text(args, "path");
    const key = text(args, "key");
    const value = checkedValue(key, text(args, "value"));
    const content = card(demo, path);
    let landed = path;
    change(demo, () => {
      demo.state.files[path] = withField(content, key, key === "title" ? value.trim() : value);
      landed = relocate(demo, path);
    });
    return landed;
  },

  create_plan: (args, demo): Answer<"createPlan"> => {
    const contextFolder = text(args, "contextFolder");
    const fileName = text(args, "fileName");
    const title = text(args, "title").trim();
    const kind = optional(args, "kind") ?? "plan";
    const parent = optional(args, "parent");
    const context = Object.values(demo.state.trees)
      .flatMap((tree) => tree.contexts)
      .find((ctx) => ctx.folderPath === contextFolder);
    if (!context) throw new DemoFailure(`not a gavin context (no .gavin or .gavin-root): ${contextFolder}`);
    if (!["note", "task", "plan"].includes(kind)) throw new DemoFailure(`invalid kind value: ${kind}`);
    if (!FILE_NAME.test(fileName)) throw new DemoFailure(`file_name must match [A-Za-z0-9._-]+.md, got: ${fileName}`);
    if (!title || title.includes("\n")) throw new DemoFailure("title must be a non-empty single line");
    if (parent && kind !== "task") throw new DemoFailure(`parent requires kind task, got: ${kind}`);
    const plansRoot = `${contextFolder}/${markerOf(context.kind)}/plans`;
    const existing = plansUnder(demo, plansRoot).find((p) => p.endsWith(`/${fileName}`));
    if (existing) throw new DemoFailure(`plan file already exists: ${existing}`);
    const status = kind === "task" && parent && optional(args, "status") === null
      ? null
      : (optional(args, "status")?.trim() ?? "To Do");
    const complexity = optional(args, "complexity");
    const info = { kind: kind as "note" | "task" | "plan", parent, status };
    const parentPath = parent ? plansUnder(demo, plansRoot).find((p) => p.endsWith(`/${parent}`)) : undefined;
    const folder = homeFolder(plansRoot, info, parentPath ? folderOf(parentPath) : null);
    const path = `${folder}/${fileName}`;
    change(demo, () => {
      demo.state.files[path] = newCardText({
        title,
        kind: info.kind,
        status,
        parent,
        priority: optional(args, "priority"),
        attachments: optional(args, "attachments")?.trim() ?? null,
        complexity: complexity ? checkedValue("complexity", complexity) : null,
        body: optional(args, "body"),
      });
    });
    return path;
  },

  set_checklist_item: (args, demo): Answer<"setChecklistItem"> => {
    const path = text(args, "path");
    const content = card(demo, path);
    let next: string;
    try {
      next = withChecklistItem(content, Number(args.lineIndex), text(args, "expectedText"), args.checked === true);
    } catch (e) {
      throw new DemoFailure(e instanceof Error ? e.message : String(e));
    }
    change(demo, () => {
      demo.state.files[path] = next;
    });
  },

  resolve_human_item: (args, demo): Answer<"resolveHumanItem"> => {
    const path = text(args, "path");
    const content = card(demo, path);
    let next: string;
    try {
      next = withHumanOutcome(content, text(args, "expectedText"), args.outcome as HumanItemOutcome, today());
    } catch (e) {
      throw new DemoFailure(e instanceof Error ? e.message : String(e));
    }
    change(demo, () => {
      demo.state.files[path] = next;
    });
  },

  // Into the context's `plans/archive/`, nested tasks and all. Archiving
  // an archived card, or restoring one that is not, is no change.
  archive_card: (args, demo): Answer<"archiveCard"> => {
    const path = text(args, "path");
    card(demo, path);
    if (isArchived(path)) return path;
    let landed = path;
    change(demo, () => {
      landed = moveWithChildren(demo, path, `${plansRootOf(path)!}/${ARCHIVE_DIR}`);
    });
    return landed;
  },
  unarchive_card: (args, demo): Answer<"unarchiveCard"> => {
    const path = text(args, "path");
    card(demo, path);
    if (!isArchived(path)) return path;
    const plansRoot = plansRootOf(path)!;
    const info = readCard(path, demo.state.files[path]);
    let landed = path;
    change(demo, () => {
      landed = moveWithChildren(demo, path, homeFolder(plansRoot, info, null));
    });
    return landed;
  },

  // A card's binding to the session running it. Kept WITH its launch
  // command, which only `card_session` answers: the board has carried
  // none since v43 (`get_board` leaves it out).
  link_card_session: (args, demo): Answer<"linkCardSession"> => {
    const board = demo.state.boards[text(args, "workspaceId")];
    if (!board) throw new DemoFailure(`no board for workspace ${String(args.workspaceId)}`);
    const path = text(args, "path");
    const record: CardSessionRecord = {
      path,
      sessionId: text(args, "sessionId"),
      cwd: text(args, "cwd"),
      command: optional(args, "command"),
      conversationId: optional(args, "conversationId"),
      launchCwd: optional(args, "launchCwd"),
      resumeAttempts: typeof args.resumeAttempts === "number" ? args.resumeAttempts : null,
      baseSha: optional(args, "baseSha"),
    };
    board.cardSessions = [...board.cardSessions.filter((cs) => cs.path !== path), record];
  },
  unlink_card_session: (args, demo): Answer<"unlinkCardSession"> => {
    const board = demo.state.boards[text(args, "workspaceId")];
    if (!board) return;
    const path = text(args, "path");
    board.cardSessions = board.cardSessions.filter((cs) => cs.path !== path);
  },
  card_session: (args, demo): Answer<"cardSession"> => {
    const path = text(args, "path");
    const binding = demo.state.boards[text(args, "workspaceId")]?.cardSessions.find((cs) => cs.path === path);
    if (!binding) return null;
    return { ...binding, command: (binding as Partial<CardSessionRecord>).command ?? null };
  },

  // What a launch reads before it spawns. An attachment is "root" when
  // it is in a workspace, and missing when the demo's disk has no such
  // file; the demo holds nothing gavin would refuse to hand an agent.
  attachment_status: (args, demo): Answer<"attachmentStatus"> => {
    const root = text(args, "root");
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
    return paths.map((path) => {
      const absolutePath = path.startsWith("/") ? path : `${root}/${path}`;
      const content = demo.state.files[absolutePath];
      return {
        path,
        absolutePath,
        exists: content !== undefined,
        location: absolutePath.startsWith(`${root}/`) ? "root" : "outside",
        refusedReason: null,
        sizeBytes: content === undefined ? null : new TextEncoder().encode(content).length,
      };
    });
  },
  // No demo project is a repository with a commit to start a run from,
  // so a run has no baseline -- which a launch takes in its stride.
  git_head_sha: (): Answer<"gitHeadSha"> => null,

  set_session_name: (args, demo): Answer<"setSessionName"> => {
    const id = text(args, "sessionId");
    const name = text(args, "name").trim();
    if (name) demo.state.sessionNames[id] = name;
    else delete demo.state.sessionNames[id];
  },

  // A follow-up for an agent, delivered the moment its input box is
  // free: pasted and sent, as the daemon delivers one. An agent that is
  // busy keeps it waiting, which the answer says.
  queue_input: (args, demo): Answer<"queueInput"> => {
    const sessionId = text(args, "sessionId");
    const program = demo.state.terminals[sessionId]?.program;
    if (!program) throw new DemoFailure(`unknown session: ${sessionId}`);
    const queued = demo.state.queuedInputs.filter((q) => q.sessionId !== sessionId);
    const mine = demo.state.queuedInputs.filter((q) => q.sessionId === sessionId);
    if (program.kind === "agent" && program.ask.kind === "composer" && mine.length === 0) {
      typeInto(demo, sessionId, `\x1b[200~${text(args, "text")}\x1b[201~\r`);
      return [];
    }
    const entry: QueuedInput = {
      id: `q-${demo.state.queuedInputs.length + 1}`,
      sessionId,
      text: text(args, "text"),
      createdAtUs: 0,
    };
    demo.state.queuedInputs = [...queued, ...mine, entry];
    return [...mine, entry];
  },
};
