// Geometry for the Unstaged/Staged divider in the Changes column.
//
// What is stored is a SHARE of the two lists' combined height, not a
// pixel height -- see splitShare.ts for why every divider in the app
// does that. The clamp itself lives there; this module is the Changes
// column's answer to its two questions: where the divider sits before
// anyone drags it, and how small a list is allowed to get.

import { shareFromSize } from "$lib/panes/splitShare";

/// Both lists share the height evenly until the divider is dragged.
export const DEFAULT_SHARE = 0.5;

/// Enough for a list header plus a row, so neither block can be dragged
/// down to an unreadable sliver.
export const MIN_LIST_PX = 56;

/// The share of `total` the block above the divider should take, given a
/// drag that wants it `desired` px tall.
export function shareFromHeight(desired: number, total: number, min = MIN_LIST_PX): number {
  return shareFromSize(desired, total, min, DEFAULT_SHARE);
}
