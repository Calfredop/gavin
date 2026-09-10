// The Orchestration tab's search lens.
//
// Rails and the unplaced pool answer to one query, but they answer
// DIFFERENTLY, because they are different kinds of list:
//
//   * The pool is a flat drawer of candidates -- non-matching rows come
//     out of it, exactly like every other list search in the app.
//   * A rail is a PIPELINE. Removing chips from the middle of one would
//     destroy the thing the human is looking at (which stage the match
//     sits in, and what runs before it), so a rail keeps its whole shape
//     and only the matching chips light up. Rails with no match at all
//     leave the grid, so what is left is scannable.

import { matchesFields, queryTokens } from "$lib/core/search";
import { unplacedCount } from "$lib/orchestration/orchestration";
import { toolKindLabel } from "$lib/orchestration/orchestrationTools";
import type { CardEntry, Orchestration, Step, UnplacedGroup } from "$lib/orchestration/orchestration";
import type { Tool } from "$lib/orchestration/orchestrationTools";
import type { GroupTemplate } from "$lib/orchestration/orchestrationGroups";

function cardFields(entry: CardEntry | undefined): string[] {
  if (!entry) return [];
  const p = entry.plan;
  return [p.title, p.fileName, p.status ?? "", p.kind, ...p.labels];
}

/// The unplaced pool, narrowed to the groups and cards a query keeps.
/// Shared by the tab's lens and the drawer's own box so one card answers
/// both the same way -- two hand-written copies would drift into two
/// different ideas of what "matches" means in one panel.
function filterGroups(groups: UnplacedGroup[], tokens: string[]): UnplacedGroup[] {
  const kept: UnplacedGroup[] = [];
  for (const group of groups) {
    // A group name is a match target too: "shipped" should show what
    // is sitting in Shipped, whatever those cards are called.
    const all = matchesFields(tokens, [group.status]);
    const cardsKept = all ? group.cards : group.cards.filter((c) => matchesFields(tokens, cardFields(c)));
    if (cardsKept.length === 0) continue;
    kept.push({ ...group, cards: cardsKept });
  }
  return kept;
}

export function stepMatches(step: Step, cards: Map<string, CardEntry>, tokens: string[]): boolean {
  const entry = cards.get(step.cardPath);
  // A step whose card file is gone shows as a broken chip; it has no
  // text to match, so it never counts as a hit.
  if (!entry) return false;
  return matchesFields(tokens, cardFields(entry));
}

export interface UnplacedResult {
  groups: UnplacedGroup[];
  /// Cards shown / in the pool -- both by `unplacedCount`, so a done
  /// group is filtered and rendered like any other but stays out of
  /// every number the tab prints.
  shown: number;
  total: number;
}

export interface OrchestrationSearch {
  filtering: boolean;
  /// Rails kept in the grid, and how many chips matched across them.
  railsShown: number;
  stepsMatched: number;
  railShown: (railId: string) => boolean;
  /// Whether a chip should be highlighted. Always false when not
  /// filtering -- nothing is "the match" when there is no query.
  stepLit: (stepId: string) => boolean;
  filterUnplaced: (groups: UnplacedGroup[]) => UnplacedResult;
}

export function searchOrchestration(
  orch: Orchestration | null,
  cards: Map<string, CardEntry>,
  query: string
): OrchestrationSearch {
  const tokens = queryTokens(query);
  const rails = orch?.rails ?? [];

  if (tokens.length === 0) {
    return {
      filtering: false,
      railsShown: rails.length,
      stepsMatched: 0,
      railShown: () => true,
      stepLit: () => false,
      filterUnplaced: (groups) => ({
        groups,
        shown: unplacedCount(groups),
        total: unplacedCount(groups),
      }),
    };
  }

  const lit = new Set<string>();
  const shownRails = new Set<string>();
  for (const rail of rails) {
    // A rail's own identity -- its name and the worktree it is bound to
    // -- is searchable, so "hotfix" finds the rail working in that
    // checkout even when no card mentions it.
    const railHit = matchesFields(tokens, [rail.name, rail.worktreePath]);
    let stepHit = false;
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        if (!stepMatches(step, cards, tokens)) continue;
        lit.add(step.id);
        stepHit = true;
      }
    }
    if (railHit || stepHit) shownRails.add(rail.id);
  }

  return {
    filtering: true,
    railsShown: shownRails.size,
    stepsMatched: lit.size,
    railShown: (railId) => shownRails.has(railId),
    stepLit: (stepId) => lit.has(stepId),
    filterUnplaced: (groups) => {
      const kept = filterGroups(groups, tokens);
      return { groups: kept, shown: unplacedCount(kept), total: unplacedCount(groups) };
    },
  };
}

// ---- The drawer's own box --------------------------------------------------
// The tab's lens above reaches the drawer's CARDS, and nothing else in
// it: a tool and a saved group are not cards, so no query ever found
// one, and the tool list is the part of that panel that grows without
// bound (fourteen built-ins, plus everything this workspace and this
// machine have saved). So the drawer carries a second, narrower box of
// its own, over the three lists it actually holds.
//
// It is a SEPARATE query on purpose, and it composes with the tab's
// rather than replacing it: the tab's box is a lens over the whole grid
// (it takes rails away), while this one only ever narrows one panel. And
// because it narrows only that panel, it does NOT lock dragging the way
// the tab's does -- a drawer row is dragged by its id and dropped at an
// index measured in the RAILS, which this query never touches.

function toolFields(tool: Tool): string[] {
  // The kind is searchable under both its wire name and the words the
  // row's own tooltip shows, so "agent" and "bash" both work.
  return [tool.name, tool.description, tool.kind, toolKindLabel(tool.kind), tool.scope];
}

function templateFields(t: GroupTemplate): string[] {
  return [t.name, t.description, t.scope, t.mode];
}

export interface DrawerLists {
  templates: GroupTemplate[];
  tools: Tool[];
  groups: UnplacedGroup[];
}

export interface DrawerSearch extends DrawerLists {
  filtering: boolean;
  templatesTotal: number;
  toolsTotal: number;
  /// Cards kept / offered, both by `unplacedCount` -- a done group is
  /// filtered and rendered like any other but stays out of every number
  /// the panel prints, exactly as the tab's lens has it.
  cardsShown: number;
  cardsTotal: number;
}

export function searchDrawer(query: string, lists: DrawerLists): DrawerSearch {
  const tokens = queryTokens(query);
  const totals = {
    templatesTotal: lists.templates.length,
    toolsTotal: lists.tools.length,
    cardsTotal: unplacedCount(lists.groups),
  };
  if (tokens.length === 0) {
    return {
      ...lists,
      ...totals,
      filtering: false,
      cardsShown: totals.cardsTotal,
    };
  }
  const groups = filterGroups(lists.groups, tokens);
  return {
    filtering: true,
    templates: lists.templates.filter((t) => matchesFields(tokens, templateFields(t))),
    tools: lists.tools.filter((t) => matchesFields(tokens, toolFields(t))),
    groups,
    ...totals,
    cardsShown: unplacedCount(groups),
  };
}
