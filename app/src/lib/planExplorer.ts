import { writable } from "svelte/store";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

// Deep link into the Plans tab: set a path here before switching the
// hub view and PlanExplorerHubView selects it (then clears the store).
export const requestedExplorerPath = writable<string | null>(null);
import { slugStatus } from "./planBoard";

export type ExplorerGroup = "plans" | "docs" | "specs";

export interface ExplorerFile {
  path: string;
  // Plan title, or the doc/spec's path relative to its group folder -- so
  // a nested guides/setup.md reads correctly instead of collapsing to a
  // bare filename.
  label: string;
  group: ExplorerGroup;
  // Plans only; null for docs and specs.
  status: string | null;
  priority: PlanFileInfo["priority"];
  parseWarning: boolean;
}

export interface ExplorerGroupNode {
  group: ExplorerGroup;
  label: string;
  files: ExplorerFile[];
  // Plans filed under `plans/done/`. Split out of `files` so the group
  // shows the work still in flight and folds the archive away behind one
  // collapsed row -- a repo with 30 shipped cards is otherwise 30 rows of
  // noise above the four that matter. Always empty for docs and specs.
  archived: ExplorerFile[];
}

export interface ExplorerContextNode {
  folderPath: string;
  name: string;
  kind: GavinContext["kind"];
  configWarning: boolean;
  // Absolute path of this context's .gavin-root/ or .gavin/ -- creation
  // targets are built from it.
  gavinDir: string;
  // Nesting among CONTEXTS, not filesystem segments: root is 0 and each
  // context is one deeper than its nearest ancestor context, so src/auth
  // under the root indents one level even though it is two folders down
  // (the intermediate folders have no row to indent under).
  depth: number;
  // Outside the workspace root (extra_contexts). Rendered set apart and
  // removable from the navigator without touching its files.
  outside: boolean;
  groups: ExplorerGroupNode[];
}

const GROUP_LABELS: Record<ExplorerGroup, string> = {
  plans: "Plans",
  docs: "Docs",
  specs: "Specs",
};

// The daemon archives a Done card by moving it into a `done/` folder
// directly under the context's `plans/` -- the folder is derived from
// status, never the reverse, so this reads the path the daemon wrote
// rather than re-deriving "is this Done?" from frontmatter.
//
// Every context, not just the root: `.gavin/plans/done/` and
// `.gavin-root/plans/done/` both match, mirroring the daemon's
// `is_plans_dir`. A hand-made `plans/roadmap/done/` does NOT -- the
// daemon never moves those, so the explorer must not fold them either.
export function isArchivedPlan(path: string): boolean {
  return path.includes("/plans/done/");
}

export function gavinDirFor(context: { folderPath: string; kind: GavinContext["kind"] }): string {
  return `${context.folderPath}/${context.kind === "root" ? ".gavin-root" : ".gavin"}`;
}

export function newFilePath(gavinDir: string, group: ExplorerGroup, fileName: string): string {
  return `${gavinDir}/${group}/${fileName}`;
}

// The tree the explorer renders. A pure projection: the daemon already
// sorts plans and md listings by name, so ordering within a group is
// inherited rather than re-derived.
export function buildExplorerTree(tree: GavinTree | undefined): ExplorerContextNode[] {
  if (!tree || tree.rootMissing) return [];

  // Root first, then workspace contexts by path, then outside contexts
  // by path -- an outside folder must never read as part of the tree.
  const contexts = [...tree.contexts].sort((a, b) => {
    const aRoot = a.kind === "root";
    const bRoot = b.kind === "root";
    if (aRoot !== bRoot) return aRoot ? -1 : 1;
    const aOut = a.outside === true;
    const bOut = b.outside === true;
    if (aOut !== bOut) return aOut ? 1 : -1;
    return a.folderPath.localeCompare(b.folderPath);
  });

  // The sort puts ancestors before their descendants (root first, and a
  // folder path always precedes paths nested under it), so the current
  // ancestor chain is a simple stack.
  const chain: { folderPath: string; depth: number }[] = [];

  return contexts.map((ctx) => {
    while (chain.length > 0 && !isUnderRoot(chain[chain.length - 1].folderPath, ctx.folderPath)) {
      chain.pop();
    }
    const depth = chain.length === 0 ? 0 : chain[chain.length - 1].depth + 1;
    chain.push({ folderPath: ctx.folderPath, depth });

    const groups: ExplorerGroupNode[] = [];

    if (ctx.plans.length > 0) {
      const planFile = (p: PlanFileInfo): ExplorerFile => ({
        path: p.path,
        label: p.title,
        group: "plans" as const,
        status: p.status,
        priority: p.priority,
        parseWarning: p.parseWarning,
      });
      groups.push({
        group: "plans",
        label: GROUP_LABELS.plans,
        files: ctx.plans.filter((p) => !isArchivedPlan(p.path)).map(planFile),
        archived: ctx.plans.filter((p) => isArchivedPlan(p.path)).map(planFile),
      });
    }
    for (const group of ["docs", "specs"] as const) {
      const list = ctx[group];
      if (list.length === 0) continue;
      groups.push({
        group,
        label: GROUP_LABELS[group],
        files: list.map((f) => ({
          path: f.path,
          label: f.relPath,
          group,
          status: null,
          priority: null,
          parseWarning: false,
        })),
        archived: [],
      });
    }

    return {
      folderPath: ctx.folderPath,
      name: ctx.name,
      kind: ctx.kind,
      configWarning: ctx.configWarning,
      gavinDir: gavinDirFor(ctx),
      depth,
      outside: ctx.outside === true,
      groups,
    };
  });
}

// Must satisfy the daemon's own [A-Za-z0-9._-]+\.md rule, so anything
// else is stripped rather than escaped. Null when nothing usable
// survives -- the caller shows an inline error instead of writing a file
// named ".md".
export function slugFileName(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}.md` : null;
}

// Strictly inside: the root itself is rejected because a .gavin beside
// .gavin-root is deliberately ignored by the scanner (Foundations spec §1
// edge rules), so creating one there would make an invisible context.
export function isUnderRoot(root: string, folder: string): boolean {
  const base = root.endsWith("/") ? root : `${root}/`;
  return folder !== root && folder.startsWith(base);
}

// The board's column names are the status vocabulary (D6). A plan whose
// status matches no column keeps its own value as an extra option, so
// opening the dropdown can never silently restatus it.
export function statusOptions(columnNames: string[], current: string | null): string[] {
  if (!current) return [...columnNames];
  const matched = columnNames.some((name) => slugStatus(name) === slugStatus(current));
  return matched ? [...columnNames] : [...columnNames, current];
}

// Every file the explorer can select, across contexts and groups.
function allFilePaths(tree: GavinTree | undefined): Set<string> {
  const paths = new Set<string>();
  if (!tree || tree.rootMissing) return paths;
  for (const ctx of tree.contexts) {
    for (const plan of ctx.plans) paths.add(plan.path);
    for (const doc of ctx.docs) paths.add(doc.path);
    for (const spec of ctx.specs) paths.add(spec.path);
  }
  return paths;
}

// Where the selected file went when it was renamed or moved on disk,
// or null if this wasn't a rename (or is too ambiguous to call one).
//
// Two consecutive watcher pushes are the only evidence available: the
// daemon rescans the tree wholesale and nothing on the wire carries file
// identity, so a rename is inferred rather than reported. The inference
// is deliberately the narrowest one that works -- exactly one file gone,
// exactly one file new, and the one that went was the selection. A push
// that coalesced a rename with any other create or delete fails that
// test and falls through to the "this file is gone" notice, which is the
// honest answer when we genuinely can't tell.
export function followRenamedPath(
  before: GavinTree | undefined,
  after: GavinTree | undefined,
  selectedPath: string
): string | null {
  const previous = allFilePaths(before);
  const current = allFilePaths(after);
  if (current.has(selectedPath) || !previous.has(selectedPath)) return null;

  const vanished = [...previous].filter((p) => !current.has(p));
  const appeared = [...current].filter((p) => !previous.has(p));
  if (vanished.length !== 1 || appeared.length !== 1) return null;
  return vanished[0] === selectedPath ? appeared[0] : null;
}

// The twin of followRenamedPath for context FOLDERS. A board tab is
// pinned to its context by folder path, so renaming or moving that
// folder on disk would otherwise leave the tab stuck on "this context no
// longer exists" -- a dead tab for what was only a rename. Same narrow
// inference, same fallback when it can't be called.
export function followRenamedContext(
  before: GavinTree | undefined,
  after: GavinTree | undefined,
  contextFolder: string
): string | null {
  const previous = new Set((before?.contexts ?? []).map((c) => c.folderPath));
  const current = new Set((after?.contexts ?? []).map((c) => c.folderPath));
  if (after?.rootMissing) return null;
  if (current.has(contextFolder) || !previous.has(contextFolder)) return null;

  const vanished = [...previous].filter((p) => !current.has(p));
  const appeared = [...current].filter((p) => !previous.has(p));
  if (vanished.length !== 1 || appeared.length !== 1) return null;
  return vanished[0] === contextFolder ? appeared[0] : null;
}
