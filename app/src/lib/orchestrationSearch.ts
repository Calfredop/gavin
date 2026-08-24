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

import { matchesFields, queryTokens } from "./search";
import type { CardEntry, Orchestration, Step, UnplacedGroup } from "./orchestration";

function cardFields(entry: CardEntry | undefined): string[] {
  if (!entry) return [];
  const p = entry.plan;
  return [p.title, p.fileName, p.status ?? "", p.kind, ...p.labels];
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
        shown: groups.reduce((n, g) => n + g.cards.length, 0),
        total: groups.reduce((n, g) => n + g.cards.length, 0),
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
      const total = groups.reduce((n, g) => n + g.cards.length, 0);
      let shown = 0;
      const kept: UnplacedGroup[] = [];
      for (const group of groups) {
        // A group name is a match target too: "shipped" should show what
        // is sitting in Shipped, whatever those cards are called.
        const all = matchesFields(tokens, [group.status]);
        const cardsKept = all ? group.cards : group.cards.filter((c) => matchesFields(tokens, cardFields(c)));
        if (cardsKept.length === 0) continue;
        shown += cardsKept.length;
        kept.push({ ...group, cards: cardsKept });
      }
      return { groups: kept, shown, total };
    },
  };
}
