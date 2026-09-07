import type { Complexity } from "./complexity";
import type { Board, Column } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

export interface CardView {
  id: string; // the card file's absolute path — stable identity
  title: string;
  // The card file's mtime in unix seconds; null (or absent) when the
  // daemon didn't send one -- a pre-v13 daemon, or a file that vanished
  // between the scan and the stat. The archive grid orders by it.
  //
  // Optional for the same reason `GavinContext.outside` is: a card view
  // is built in a dozen test fixtures with no opinion about dates, and
  // making every one of them state a null would be noise. The projection
  // itself always sets it.
  modifiedAt?: number | null;
  status: string | null;
  priority: PlanFileInfo["priority"];
  order: number | null;
  kind: "note" | "task" | "plan";
  parent: string | null;
  // Resolved parent's title for the chip; null when parent is unset.
  parentTitle: string | null;
  // parent set but unresolved / non-plan / self — rendered as a broken
  // chip, the card stays visible (never hidden by a bad link).
  parentBroken: boolean;
  labels: string[];
  // Files this card points an agent at, exactly as the frontmatter
  // records them. Optional for the same reason `modifiedAt` is: a card
  // view is built in a dozen fixtures with no opinion about
  // attachments, and a pre-v18 daemon never sends the field. The
  // projection itself always sets it.
  attachments?: string[];
  // How hard this card's work is, or null where it says nothing -- which
  // is what makes it run the workspace's own agent rather than a level's.
  // Optional for the same reason `attachments` is: a card view is built
  // in a dozen fixtures with no opinion about it, and a pre-v31 daemon
  // never sends the field. The projection itself always sets it.
  complexity?: Complexity | null;
  // The agent profile and model THIS card names for itself, raw as the
  // frontmatter records them, or null where it names neither. Read
  // WHOLE rather than merged with the level's pair: a model name from
  // one CLI in another's argv is garbage, so a card that says anything
  // replaces what its complexity level would have picked. Optional for
  // the same reason `complexity` is -- fixtures, and a pre-v32 daemon
  // never sends either.
  agent?: string | null;
  model?: string | null;
  checklistDone: number;
  checklistTotal: number;
  contextName: string;
  contextFolder: string;
  fileName: string;
  parseWarning: boolean;
  // Plan cards only: children (parent → this file, no status) in order.
  nestedChildren: CardView[];
}

export interface DisplayColumn {
  column: Column;
  planCards: CardView[];
}

export interface AutoColumn {
  status: string;
  planCards: CardView[];
}

/// What one merge yields: the board's columns, the auto columns a
/// non-matching status conjures, and the archive -- which is NOT a
/// column. Archived cards are deliberately off the board; the kanban
/// tab's archive toggle is the only surface that renders them.
export interface MergedProjection {
  columns: DisplayColumn[];
  autoColumns: AutoColumn[];
  archived: CardView[];
}

/// A card the human archived: it lives in its context's
/// `plans/archive/`, which is the daemon's `ARCHIVE_DIR`. Derived from
/// the PATH rather than re-derived from frontmatter, because the folder
/// is the archive -- there is no `archived:` field to disagree with it.
///
/// Deliberately narrow, exactly like `isArchivedPlan`'s `done/` check: a
/// hand-made `plans/roadmap/archive/` is somebody else's hierarchy and
/// the daemon refuses to file cards into it, so this must not claim it.
export function isArchivedCard(path: string): boolean {
  return path.includes("/plans/archive/");
}

// "In Progress", "in-progress", "in_progress", " IN  PROGRESS " all meet.
export function slugStatus(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The three canonical statuses (D6's vocabulary): always present, never
// deletable, still freely reorderable. Everything else on the board is a
// custom column the human owns entirely. Matched by slug so "to do" and
// "To Do" are the same column.
export const PERMANENT_COLUMN_NAMES = ["To Do", "In Progress", "Done"] as const;

export function isPermanentColumn(name: string): boolean {
  const slug = slugStatus(name);
  return PERMANENT_COLUMN_NAMES.some((n) => slugStatus(n) === slug);
}

function cardView(ctx: GavinContext, plan: PlanFileInfo): CardView {
  return {
    id: plan.path,
    title: plan.title,
    modifiedAt: plan.modifiedAt ?? null,
    status: plan.status,
    priority: plan.priority,
    order: plan.order,
    kind: plan.kind,
    parent: plan.parent,
    parentTitle: null,
    parentBroken: false,
    labels: plan.labels,
    attachments: plan.attachments ?? [],
    complexity: plan.complexity ?? null,
    agent: plan.agent ?? null,
    model: plan.model ?? null,
    checklistDone: plan.checklistDone,
    checklistTotal: plan.checklistTotal,
    contextName: ctx.name,
    contextFolder: ctx.folderPath,
    fileName: plan.fileName,
    parseWarning: plan.parseWarning,
    nestedChildren: [],
  };
}

/// One card, by its file path, as the run actions want it.
///
/// `runCard`/`resumeCard` take a CardView because that is what every
/// surface holding one has, and until auto-resume there was always a
/// surface: a click on a board card, a menu entry, a column action. The
/// unattended path starts from a session id instead and has to build the
/// same view from the tree, and it must be the SAME projection -- a
/// second hand-rolled one would drift from the board's in exactly the
/// fields a run depends on (the attachments it gates on, the status it
/// writes past).
///
/// Null when no context holds that path: a card deleted or archived
/// between the failure and the decision, which is a reason not to run it.
export function cardViewForPath(tree: GavinTree | undefined, path: string): CardView | null {
  for (const ctx of tree?.contexts ?? []) {
    const plan = ctx.plans.find((p) => p.path === path);
    if (plan) return cardView(ctx, plan);
  }
  return null;
}

// The board's plan-card projection (spec §1). With `filter`, only that
// context's plans appear AND free-form cards are dropped (the per-session
// board shows the columns for structure only). Statuses whose slug is
// empty count as no status; no status lands in the first real column, or
// in a "(no status)" auto column when the board has none.
/// The key a nested child resolves its parent on: (contextFolder,
/// fileName) joined with a NUL -- the one character neither a folder nor
/// a file name can hold, so no two distinct pairs can collide by
/// spelling. Exported because the scheduler resolves the same link for
/// the same reason (orchestration.effectiveStatus): one spelling of
/// "which plan is this card's parent", not two that can drift.
///
/// Plan cards are indexed by this key:
/// the one character neither a folder nor a file name can hold, so no two
/// distinct pairs can collide by spelling.
///
/// Written as the \u0000 ESCAPE, never as a literal NUL byte in the source.
/// A raw one makes git classify this whole file as BINARY -- no diffs, no
/// merge resolution, and grep skips it -- which is how two of them sat here
/// unnoticed. The runtime string is identical either way.
export function planKey(contextFolder: string, fileName: string): string {
  return `${contextFolder}\u0000${fileName}`;
}

export function mergePlanCards(
  board: Board,
  tree: GavinTree | undefined,
  filter?: { contextFolder: string }
): MergedProjection {
  const columns: DisplayColumn[] = board.columns.map((column) => ({
    column,
    planCards: [],
  }));

  const contexts =
    !tree || tree.rootMissing
      ? []
      : filter
        ? tree.contexts.filter((c) => c.folderPath === filter.contextFolder)
        : tree.contexts;

  const entries: Array<{ ctx: GavinContext; plan: PlanFileInfo }> = [];
  for (const ctx of contexts) {
    for (const plan of ctx.plans) entries.push({ ctx, plan });
  }
  // Manual order first (spec §2): ordered cards ascending, unordered
  // cards after them in the old deterministic (folder, filename) order.
  entries.sort((a, b) => {
    const ao = a.plan.order ?? Number.POSITIVE_INFINITY;
    const bo = b.plan.order ?? Number.POSITIVE_INFINITY;
    if (ao < bo) return -1;
    if (ao > bo) return 1;
    return (
      a.ctx.folderPath.localeCompare(b.ctx.folderPath) || a.plan.fileName.localeCompare(b.plan.fileName)
    );
  });

  const columnBySlug = new Map<string, DisplayColumn>();
  for (const dc of columns) {
    const slug = slugStatus(dc.column.name);
    if (slug && !columnBySlug.has(slug)) columnBySlug.set(slug, dc);
  }

  // Pass 1: build every view in global sort order, indexing plan cards
  // by (contextFolder, fileName) so children can resolve their parent.
  const views = entries.map(({ ctx, plan }) => cardView(ctx, plan));
  const planByKey = new Map<string, CardView>();
  for (const v of views) {
    if (v.kind === "plan") planByKey.set(planKey(v.contextFolder, v.fileName), v);
  }

  // Pass 2: resolve parents (card-model spec §2). A task whose parent
  // resolves to a plan in the same context: with no status it NESTS
  // (pulled out of column flow into the plan's children); with a status
  // it stays in its column wearing the parent's title. A parent that
  // resolves to nothing / a non-plan / itself marks the card broken but
  // never hides it.
  const distributable: CardView[] = [];
  for (const v of views) {
    if (v.kind !== "task" || !v.parent) {
      distributable.push(v);
      continue;
    }
    const target = v.parent === v.fileName ? undefined : planByKey.get(planKey(v.contextFolder, v.parent));
    if (!target) {
      v.parentBroken = true;
      distributable.push(v);
      continue;
    }
    v.parentTitle = target.title;
    if (v.status === null) {
      target.nestedChildren.push(v);
    } else {
      distributable.push(v);
    }
  }

  // Pass 3: distribute. An archived card is pulled out BEFORE any column
  // sees it -- the archive is off the board by definition, and its cards
  // still wear the status they were archived with, so leaving them in
  // would put them straight back in the Done column.
  //
  // Deliberately after nesting: an archived plan's children travel with
  // it on disk, so they have already attached to their parent and ride
  // into the archive inside it rather than as loose cards.
  const NO_STATUS = "(no status)";
  const archived: CardView[] = [];
  const autoByKey = new Map<string, AutoColumn>();
  for (const view of distributable) {
    if (isArchivedCard(view.id)) {
      archived.push(view);
      continue;
    }
    const slug = view.status ? slugStatus(view.status) : "";
    if (!slug) {
      if (columns.length > 0) {
        columns[0].planCards.push(view);
      } else {
        const auto = autoByKey.get("") ?? { status: NO_STATUS, planCards: [] };
        auto.planCards.push(view);
        autoByKey.set("", auto);
      }
      continue;
    }
    const target = columnBySlug.get(slug);
    if (target) {
      target.planCards.push(view);
    } else {
      // Key by slug so "Blocked" and "blocked" share one auto column;
      // label with the first raw spelling seen.
      const auto = autoByKey.get(slug) ?? { status: view.status ?? slug, planCards: [] };
      auto.planCards.push(view);
      autoByKey.set(slug, auto);
    }
  }

  const autoColumns = [...autoByKey.values()].sort((a, b) => a.status.localeCompare(b.status));
  return { columns, autoColumns, archived };
}

// The deepest context whose folderPath is an ancestor of (or equal to)
// cwd, path-segment aware ("/a/auth2" is not under "/a/auth"). The root
// context participates like any other.
export function nearestContext(tree: GavinTree | undefined, cwd: string | undefined): GavinContext | null {
  if (!tree || tree.rootMissing || !cwd) return null;
  let best: GavinContext | null = null;
  for (const ctx of tree.contexts) {
    const folder = ctx.folderPath;
    const isAncestor = cwd === folder || cwd.startsWith(folder.endsWith("/") ? folder : folder + "/");
    if (isAncestor && (!best || folder.length > best.folderPath.length)) {
      best = ctx;
    }
  }
  return best;
}

/// A card view together with the board column it sits in — what a surface
/// OFF the board needs, where the column is no longer implied by which
/// strip the card is standing in (the Orchestration tab's rails).
export interface PlacedCardView {
  view: CardView;
  /// The column's own name, an auto column's status spelling, or null for
  /// a nested child — nesting pulls a card out of column flow entirely,
  /// and claiming a column for it would be a lie.
  columnName: string | null;
}

/// Index a merged projection by card path, nested children included.
/// Takes the projection rather than (board, tree) so a surface that
/// already called mergePlanCards does not pay for it twice.
export function indexCardViews(merged: {
  columns: DisplayColumn[];
  autoColumns: AutoColumn[];
  archived?: CardView[];
}): Map<string, PlacedCardView> {
  const index = new Map<string, PlacedCardView>();
  const add = (view: CardView, columnName: string | null): void => {
    index.set(view.id, { view, columnName });
    for (const child of view.nestedChildren) add(child, null);
  };
  for (const dc of merged.columns) {
    for (const view of dc.planCards) add(view, dc.column.name);
  }
  for (const auto of merged.autoColumns) {
    for (const view of auto.planCards) add(view, auto.status);
  }
  // Archived cards resolve too, with no column: a rail step whose card
  // has been archived must still render as itself rather than vanishing
  // into "missing card".
  for (const view of merged.archived ?? []) add(view, null);
  return index;
}
