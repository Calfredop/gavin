// An agent's browser as the phone draws it: the button beside the
// terminal, and what the view shows. The rules of the stream are the
// desk's (`$lib/panes/browserView.ts`); its ports are the phone's
// (state/browser.ts).
import { chipFor, paneShows, type BrowserView, type PaneShows } from "$lib/panes/browserView";

export interface BrowserButton {
  label: string;
  /// The view is on screen, and the button takes it away.
  pressed: boolean;
}

/// The terminal header's browser button, or null when there is nothing to
/// show: no browser running and no view up. A browser the phone cannot
/// show keeps its button, and the view says why -- a phone has no tooltip
/// to say it on a button that does nothing.
export function browserButton(view: BrowserView | undefined, shown: boolean): BrowserButton | null {
  if (shown) return { label: "Hide this agent's browser", pressed: true };
  const chip = chipFor(view, null);
  return chip ? { label: chip.tip, pressed: false } : null;
}

/// What the view shows: the desk pane's answer, with the desk's reason for
/// not streaming in place of a wait that would not end. A frame already
/// in hand is still drawn, with the reason over it.
export function browserViewShows(
  view: BrowserView | undefined,
  blocked: string | null,
  problem: string | null
): PaneShows {
  return paneShows(view, blocked ?? (view?.frame ? null : problem));
}
