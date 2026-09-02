// Geometry for the Unstaged/Staged divider in the Changes column.
//
// What is stored is a SHARE of the two lists' combined height, not a
// pixel height: the column is a flex stack whose free height changes
// with the window, the filter bar and the commit box. A pixel height
// would have to be re-clamped against all of them -- and a stale one
// would squeeze the other list to nothing the first time the pane got
// short. A share is applied as the pair's flex-grow factors, so the
// split the human dragged holds at every pane size and can never
// overflow the column.
//
// Pure on purpose: GitChanges.svelte measures the two blocks and hands
// the numbers over, which keeps the only decision here testable.

/// Both lists share the height evenly until the divider is dragged.
export const DEFAULT_SHARE = 0.5;

/// Enough for a list header plus a row, so neither block can be dragged
/// down to an unreadable sliver.
export const MIN_LIST_PX = 56;

/// The share of `total` the block above the divider should take, given a
/// drag that wants it `desired` px tall. Clamped so neither block falls
/// below `min`; when `total` cannot hold two minimums (or is not yet
/// measurable) the pair splits evenly instead of pinning one block open
/// and clipping the other out of existence.
export function shareFromHeight(desired: number, total: number, min = MIN_LIST_PX): number {
  if (!(total > 0) || total <= min * 2) return DEFAULT_SHARE;
  const px = Math.min(Math.max(desired, min), total - min);
  return Math.round((px / total) * 1e4) / 1e4;
}
