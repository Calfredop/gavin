// What a draggable divider stores.
//
// Every divider in the app that has to survive its pane changing size
// keeps a SHARE of the pair it splits, never a pixel size: the pane is
// as big as the window, the tab strip and its neighbours leave it, and a
// stale pixel size would have to be re-clamped against all of them --
// squeezing one side to nothing the first time the pane got small. A
// share is applied as the pair's flex-grow (or grid `fr`) factors, so
// the split the human dragged holds at every pane size and can never
// overflow.
//
// Pure on purpose: the components measure their two blocks and hand the
// numbers over, which keeps the only decision here testable.

/// The share of `total` the block BEFORE the divider should take, given
/// a drag that wants it `desired` px. Clamped so neither block falls
/// below `min`; when `total` cannot hold two minimums -- or is not yet
/// measurable -- the pair falls back to `fallback` rather than pinning
/// one block open and clipping the other out of existence.
export function shareFromSize(
  desired: number,
  total: number,
  min: number,
  fallback: number
): number {
  if (!(total > 0) || total <= min * 2) return fallback;
  const px = Math.min(Math.max(desired, min), total - min);
  return Math.round((px / total) * 1e4) / 1e4;
}
