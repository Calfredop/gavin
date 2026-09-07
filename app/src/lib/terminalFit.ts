/// The one question every refit has to ask first: does this pane have a
/// box to be measured at all?
///
/// Pure and separate from TerminalPane.svelte because the answer is a
/// judgement about a MEASUREMENT, and the pane that takes the measurement
/// is the one thing in the terminal path no suite renders.

/// Whether a pane's measured box is worth fitting a terminal to.
///
/// A refit is not a free no-op when the box is empty. `FitAddon`'s
/// `proposeDimensions` floors its answer -- `Math.max(2, …)` columns and
/// `Math.max(1, …)` rows -- so it never declines to answer for a collapsed
/// box; it answers with the floor. Measured in WKWebView against this
/// app's own CSS and xterm build: a pane at 800x400 proposes 100x26, and
/// the SAME pane at 800x0 proposes 100 columns by ONE row. `fit()` then
/// reflows the terminal to that shape and `resizeSession` reports it, so
/// the daemon SIGWINCHes a live agent into a one-row terminal and the
/// full-screen TUI redraws itself into it. Giving the height back afterwards
/// restores the geometry and cannot restore the buffer: the reflow already
/// happened, and what the agent had drawn is gone.
///
/// So the guard is about ZERO, not about smallness. A pane the human has
/// genuinely dragged down to one row IS one row, and reporting it is
/// correct; a pane with no box has not been measured at all, and the floor
/// FitAddon returns for it is not a measurement of anything. Anything
/// non-finite is refused for the same reason -- a `display: none` ancestor
/// makes the computed height the string "auto", which is where FitAddon's
/// own NaN check comes from, and this must not be laxer than that.
export function fitWorthTaking(width: number, height: number): boolean {
  return (
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
  );
}
