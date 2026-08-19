// Pure math for manual plan-card ordering (spec §2). `order:` is an
// integer frontmatter field; cards sort by (order ?? +Infinity,
// contextFolder, fileName). Given a drop, this computes the minimal set
// of frontmatter writes: one midpoint write in the steady state, a
// block renumber when the gap is exhausted or a needed neighbor has no
// order yet (the first manual ordering in a column materializes the
// whole block).

export interface OrderedPlanCard {
  path: string;
  order: number | null;
}

export interface OrderWrite {
  path: string;
  order: number;
}

export const ORDER_GAP = 1024;

// cards: the target column's plan block in visual order, dragged card
// EXCLUDED. targetIndex: the post-removal slot (0..cards.length).
export function computeOrderWrites(
  cards: OrderedPlanCard[],
  targetIndex: number,
  draggedPath: string
): OrderWrite[] {
  const clamped = Math.max(0, Math.min(targetIndex, cards.length));
  const before = clamped > 0 ? cards[clamped - 1] : null;
  const after = clamped < cards.length ? cards[clamped] : null;

  if ((before && before.order === null) || (after && after.order === null)) {
    return renumber(cards, clamped, draggedPath);
  }
  if (!before && !after) return [{ path: draggedPath, order: ORDER_GAP }];
  if (!before) return [{ path: draggedPath, order: (after as OrderedPlanCard).order! - ORDER_GAP }];
  if (!after) return [{ path: draggedPath, order: before.order! + ORDER_GAP }];
  if (after.order! - before.order! >= 2) {
    return [{ path: draggedPath, order: Math.floor((before.order! + after.order!) / 2) }];
  }
  return renumber(cards, clamped, draggedPath);
}

function renumber(cards: OrderedPlanCard[], targetIndex: number, draggedPath: string): OrderWrite[] {
  const paths = cards.map((card) => card.path);
  paths.splice(targetIndex, 0, draggedPath);
  return paths.map((path, i) => ({ path, order: (i + 1) * ORDER_GAP }));
}
