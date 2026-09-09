// How a card's detail modal reaches the cards around it (card-model spec
// §4: the children list is click-through). The modal is a pure function
// of ONE card path the host holds, so moving between related cards means
// handing the host another path -- which only navigates when the host's
// own projection can resolve it. A path it cannot resolve makes `openPlan`
// null and the modal VANISHES instead of moving, so both helpers answer
// with cards drawn from `allCards` rather than with a raw frontmatter
// link.

import type { CardView } from "$lib/planBoard";

/// Every card hanging off this plan, in the order the detail modal lists
/// them: the nested children first (they exist nowhere else on the
/// board), then the free-standing ones that kept a column of their own.
///
/// Deduplicated by path because the list is rendered keyed by id, and a
/// surface whose `allCards` happens to carry a card twice would take the
/// whole modal down with a duplicate-key error.
export function childCards(card: CardView, allCards: CardView[]): CardView[] {
  if (card.kind !== "plan") return [];
  const out: CardView[] = [];
  const seen = new Set<string>();
  const push = (c: CardView): void => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  };
  for (const child of card.nestedChildren) push(child);
  for (const c of allCards) {
    // Same rule the deletion cascade un-parents by: a parent link only
    // binds inside its own context, and a card is never its own child.
    if (
      c.parent === card.fileName &&
      c.contextFolder === card.contextFolder &&
      c.status !== null &&
      c.id !== card.id
    )
      push(c);
  }
  return out;
}

/// The plan this card is "part of", resolved to an entry of `allCards`.
///
/// null when there is no parent, when the link is broken (the modal
/// already says so in its own words), or when the parent sits outside
/// this surface's projection -- a page-scoped board carries no archive,
/// so an archived plan's free-standing child must keep reading its
/// parent's title as plain text rather than offering a link that closes
/// the modal.
export function parentCard(card: CardView, allCards: CardView[]): CardView | null {
  if (card.parent === null || card.parentBroken) return null;
  return (
    allCards.find(
      (c) =>
        c.fileName === card.parent && c.contextFolder === card.contextFolder && c.id !== card.id
    ) ?? null
  );
}
