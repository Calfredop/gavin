import type { Board, Column } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

export interface PlanCardView {
  id: string; // the plan file's absolute path — stable identity
  title: string;
  status: string | null;
  priority: PlanFileInfo["priority"];
  order: number | null;
  contextName: string;
  fileName: string;
  parseWarning: boolean;
}

export interface DisplayColumn {
  column: Column;
  planCards: PlanCardView[];
}

export interface AutoColumn {
  status: string;
  planCards: PlanCardView[];
}

// "In Progress", "in-progress", "in_progress", " IN  PROGRESS " all meet.
export function slugStatus(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function planView(ctx: GavinContext, plan: PlanFileInfo): PlanCardView {
  return {
    id: plan.path,
    title: plan.title,
    status: plan.status,
    priority: plan.priority,
    order: plan.order,
    contextName: ctx.name,
    fileName: plan.fileName,
    parseWarning: plan.parseWarning,
  };
}

// The board's plan-card projection (spec §1). With `filter`, only that
// context's plans appear AND free-form cards are dropped (the per-session
// board shows the columns for structure only). Statuses whose slug is
// empty count as no status; no status lands in the first real column, or
// in a "(no status)" auto column when the board has none.
export function mergePlanCards(
  board: Board,
  tree: GavinTree | undefined,
  filter?: { contextFolder: string }
): { columns: DisplayColumn[]; autoColumns: AutoColumn[] } {
  const columns: DisplayColumn[] = board.columns.map((column) => ({
    column: filter ? { ...column, cards: [] } : column,
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

  const NO_STATUS = "(no status)";
  const autoByKey = new Map<string, AutoColumn>();
  for (const { ctx, plan } of entries) {
    const view = planView(ctx, plan);
    const slug = plan.status ? slugStatus(plan.status) : "";
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
      const auto = autoByKey.get(slug) ?? { status: plan.status ?? slug, planCards: [] };
      auto.planCards.push(view);
      autoByKey.set(slug, auto);
    }
  }

  const autoColumns = [...autoByKey.values()].sort((a, b) => a.status.localeCompare(b.status));
  return { columns, autoColumns };
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
