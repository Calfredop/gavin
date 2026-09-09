// The Plans tab's filter: free text over every file in the navigator,
// plus four facets. STATUS is exclusive to this tab; CONTEXT, KIND and
// RAIL are the trio the Kanban and Review tabs answer the same way
// (boardFilters.ts's BoardFacets, shared across tabs by hubFacets.ts) --
// two surfaces asking "which rail?" must not answer it two ways, and
// nor should a third.
//
// STATUS, KIND and RAIL are ANDed with the text, and are exclusive to
// CARDS -- plans and the archive alike: docs and specs have no
// frontmatter contract, so setting any of them takes those groups out of
// the tree rather than showing them as unexplained empties. CONTEXT is
// different: it narrows which CONTEXT NODES appear at all, docs and
// specs included, since it answers "where" rather than "what".

import { matchesFields, queryTokens } from "$lib/core/search";
import { slugStatus } from "$lib/core/planBoard";
import { isCardGroup } from "$lib/files/planExplorer";
import type { ExplorerContextNode, ExplorerFile, ExplorerGroupNode } from "$lib/files/planExplorer";
import type { Orchestration } from "$lib/orchestration/orchestration";

/// The "no facet set" sentinel for both dropdowns.
export const ANY = "";
/// The rail facet's "on no rail at all" option.
export const NO_RAIL = "__unplaced__";

export interface RailIndex {
  /// Card path -> the id of the rail holding it. A card can only sit on
  /// one rail (addStep removes it from any other), so this is 1:1.
  byCard: Map<string, string>;
  rails: { id: string; name: string }[];
}

/// Path-segment aware containment: "/a/auth2" is not under "/a/auth".
/// Shared by the context facet here and in boardFilters.ts -- a card's
/// context and a tree node's folder path are the same kind of string, so
/// one test serves both.
export function underContext(folder: string, contextFolder: string): boolean {
  if (folder === contextFolder) return true;
  const base = contextFolder.endsWith("/") ? contextFolder : `${contextFolder}/`;
  return folder.startsWith(base);
}

export function railIndex(orch: Orchestration | null): RailIndex {
  const byCard = new Map<string, string>();
  const rails: { id: string; name: string }[] = [];
  for (const rail of [...(orch?.rails ?? [])].sort((a, b) => a.position - b.position)) {
    rails.push({ id: rail.id, name: rail.name });
    for (const stage of rail.stages) {
      for (const step of stage.steps) byCard.set(step.cardPath, rail.id);
    }
  }
  return { byCard, rails };
}

/// The status dropdown's options: the board's columns (the status
/// vocabulary), then any status a file actually wears that no column
/// covers -- otherwise a card stuck on a retired status would be
/// unreachable from here.
export function statusFacets(columnNames: string[], contexts: ExplorerContextNode[]): string[] {
  const out = [...columnNames];
  const seen = new Set(columnNames.map(slugStatus));
  for (const ctx of contexts) {
    for (const group of ctx.groups) {
      if (!isCardGroup(group.group)) continue;
      for (const file of [...group.files, ...group.archived]) {
        const slug = file.status ? slugStatus(file.status) : "";
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        out.push(file.status as string);
      }
    }
  }
  return out;
}

export interface PlanFilterState {
  query: string;
  /// A status name, or ANY. Compared by slug.
  status: string;
  /// A rail id, NO_RAIL, or ANY.
  rail: string;
  /// A context's folder path, or ANY for every context -- same meaning
  /// as BoardFacets.context.
  context: string;
  /// A card kind ("plan" | "task" | "note"), or ANY.
  kind: string;
}

export interface FilteredExplorer {
  contexts: ExplorerContextNode[];
  filtering: boolean;
  shown: number;
  total: number;
}

function countFiles(contexts: ExplorerContextNode[]): number {
  return contexts.reduce(
    (n, c) => n + c.groups.reduce((m, g) => m + g.files.length + g.archived.length, 0),
    0
  );
}

function fileKeeper(state: PlanFilterState, rails: RailIndex): (file: ExplorerFile) => boolean {
  const tokens = queryTokens(state.query);
  const wantStatus = state.status === ANY ? null : slugStatus(state.status);
  const wantRail = state.rail === ANY ? null : state.rail;
  const wantKind = state.kind === ANY ? null : state.kind;

  return (file) => {
    if (!matchesFields(tokens, [file.label, file.path, file.status])) return false;
    // Archived cards answer every card-only facet: they are ordinary
    // plan files that happen to be filed away, and they keep the status
    // they were archived with. Only docs and specs are taken out of the
    // tree.
    if (wantStatus !== null) {
      if (!isCardGroup(file.group)) return false;
      if (slugStatus(file.status ?? "") !== wantStatus) return false;
    }
    if (wantRail !== null) {
      if (!isCardGroup(file.group)) return false;
      const on = rails.byCard.get(file.path);
      if (wantRail === NO_RAIL ? on !== undefined : on !== wantRail) return false;
    }
    if (wantKind !== null) {
      if (!isCardGroup(file.group)) return false;
      if ((file.kind ?? null) !== wantKind) return false;
    }
    return true;
  };
}

export function filterExplorer(
  contexts: ExplorerContextNode[],
  state: PlanFilterState,
  rails: RailIndex
): FilteredExplorer {
  const total = countFiles(contexts);
  const filtering =
    queryTokens(state.query).length > 0 ||
    state.status !== ANY ||
    state.rail !== ANY ||
    state.context !== ANY ||
    state.kind !== ANY;
  if (!filtering) return { contexts, filtering: false, shown: total, total };

  const keep = fileKeeper(state, rails);
  const out: ExplorerContextNode[] = [];
  let shown = 0;
  for (const ctx of contexts) {
    // Answers "where", not "what": a context outside the chosen folder
    // drops whole, docs and specs included -- unlike the card-only
    // facets below, which narrow a context's contents rather than the
    // set of contexts.
    if (state.context !== ANY && !underContext(ctx.folderPath, state.context)) continue;
    const groups: ExplorerGroupNode[] = [];
    for (const group of ctx.groups) {
      // Archived cards are searched too, and a hit is promoted into the
      // flat list: folding a match away behind the Done node would show
      // the human a result count they cannot see the results for.
      const files = [...group.files, ...group.archived].filter(keep);
      if (files.length === 0) continue;
      shown += files.length;
      groups.push({ ...group, files, archived: [] });
    }
    // A context with nothing left drops out: an empty row would be one
    // more thing to scroll past, and the search is here to shorten the
    // list, not restate it.
    if (groups.length > 0) out.push({ ...ctx, groups });
  }
  return { contexts: out, filtering: true, shown, total };
}
