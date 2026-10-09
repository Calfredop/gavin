// Geometry for the Home tab's divider between the main agent and the
// PRD/Board/Orchestration column, and for the one inside the main agent's
// cell between its terminal and its browser.
//
// Stored as a SHARE of the row rather than a pixel width, for the reason
// splitShare.ts sets out: the row is as wide as the window and the
// sidebar leave it, and a stale pixel width would squeeze one side to
// nothing the first time the pane got narrow. The share reaches the DOM
// as the grid's two `fr` factors, so the split the human dragged holds
// at every pane width.

import { shareFromSize } from "$lib/panes/splitShare";

/// The 3fr : 2fr the tab shipped with, kept as where an undragged
/// divider sits -- so turning the fixed split into a draggable one
/// changes nothing until someone drags it.
export const DEFAULT_AGENT_SHARE = 0.6;

/// Enough for a narrow but usable terminal on the left, and for a panel
/// heading plus a board column chip on the right.
export const MIN_HOME_PANE_PX = 240;

/// The grab area between the two cells. Exactly the gutter the grid used
/// to hold, so an idle home tab looks the way it always did.
export const DIVIDER_PX = 10;

/// The band a stored share has to fall in to be believed. config.json is
/// a file a human can hand-edit, and a share of 5 (or of NaN) would
/// render one cell off the pane with no divider left on screen to drag
/// back -- so anything outside the band reads as no preference at all.
export const MIN_AGENT_SHARE = 0.15;
export const MAX_AGENT_SHARE = 0.85;

/// The share a drag wanting the agent cell `desired` px wide should
/// store, given the pair's combined width.
export function agentShareFromWidth(
  desired: number,
  total: number,
  min = MIN_HOME_PANE_PX
): number {
  return shareFromSize(desired, total, min, DEFAULT_AGENT_SHARE);
}

/// The main agent's cell once its browser is shown: the terminal above,
/// the browser below, even until someone drags the divider between them.
export const DEFAULT_TERMINAL_SHARE = 0.5;

/// Enough for a few lines of the agent's terminal above, and for the
/// browser's address row and a strip of the page below.
export const MIN_AGENT_ROW_PX = 120;

/// The share of the cell the terminal should keep, given a drag that
/// wants it `desired` px tall and the pair's combined height.
export function terminalShareFromHeight(
  desired: number,
  total: number,
  min = MIN_AGENT_ROW_PX
): number {
  return shareFromSize(desired, total, min, DEFAULT_TERMINAL_SHARE);
}

/// What to render for a stored preference, absent or otherwise.
export function resolveAgentShare(stored: number | null | undefined): number {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return DEFAULT_AGENT_SHARE;
  if (stored < MIN_AGENT_SHARE || stored > MAX_AGENT_SHARE) return DEFAULT_AGENT_SHARE;
  return stored;
}

/// The grid template the two cells and their divider sit in. Rounded to
/// the same four decimals a dragged share carries, so a drag can never
/// write a track like `0.30000000000000004fr`.
export function homeGridColumns(share: number): string {
  const left = Math.round(share * 1e4) / 1e4;
  const right = Math.round((1 - left) * 1e4) / 1e4;
  return `${left}fr ${DIVIDER_PX}px ${right}fr`;
}
