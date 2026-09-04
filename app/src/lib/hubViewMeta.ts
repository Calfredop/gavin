// Which hub tabs a workspace offers, as data. Component-free on purpose:
// workspaceViews.ts binds these ids to Svelte components, so anything
// that only needs the POLICY (the keyboard router, its tests) can import
// this without pulling in the whole component graph.
import { hubViewIsVisible, type Workspace } from "./workspace";

export interface HubViewMeta {
  id: string;
  label: string;
  /// Only offered once the workspace is bound to a root folder: these
  /// views edit files that live under it.
  requiresRoot?: boolean;
  /// Offered, but NOT as a tab in the strip -- reached by a button in the
  /// row's actions instead. The view itself is unchanged: it still has an
  /// id the workspace remembers, and switchWorkspaceView still opens it.
  /// This only says the strip is the wrong place to spend a tab on it.
  viaAction?: boolean;
}

export const HUB_VIEW_META: HubViewMeta[] = [
  { id: "home", label: "Home", requiresRoot: true },
  { id: "git", label: "Git", requiresRoot: true },
  { id: "kanban", label: "Kanban" },
  { id: "orchestration", label: "Orchestration", requiresRoot: true },
  // Sibling of Orchestration and next to it deliberately: both run the
  // same tool library, and the difference between them is only whether
  // a rail is carrying the tool. requiresRoot because a tool runs in a
  // checkout -- a workspace with no folder has nowhere to run one.
  { id: "tools", label: "Tools", requiresRoot: true },
  { id: "prd", label: "PRD", requiresRoot: true },
  { id: "agent-file", label: "CLAUDE.md", requiresRoot: true },
  { id: "plans", label: "Plans", requiresRoot: true },
  { id: "files", label: "Files", requiresRoot: true },
  // No requiresRoot: binding the root is one of this view's jobs.
  //
  // viaAction: it is the workspace's own settings, not a view OF the
  // workspace like the eight above -- and it is the one a human opens to
  // change something and then leaves, rather than one they work in. A
  // tab of its own put it in the same rank as Kanban and Git and pushed
  // them all one place left; the gear at the right of the row says the
  // same thing in the place the OS has been putting it for forty years.
  { id: "settings", label: "Settings", viaAction: true },
];

const VIA_ACTION_IDS = new Set(HUB_VIEW_META.filter((v) => v.viaAction).map((v) => v.id));

/// One strip's arrangement: the order it draws its tabs in, and which of
/// them it hides.
///
/// Both are nullable, and `null` is not the same as an empty list. An
/// empty `hidden` is a real answer -- "this workspace shows everything",
/// which must survive the app-wide default being changed underneath it --
/// so "nothing chosen here, inherit" needs a state of its own.
export interface HubTabPrefs {
  order: string[] | null;
  hidden: string[] | null;
}

/// What a caller that has no preferences to hand passes, and what the
/// strip looked like before this existed: declaration order, nothing
/// hidden. A shared constant rather than a literal per call site so a
/// default argument can never drift from the shipped behaviour.
export const NO_HUB_TAB_PREFS: HubTabPrefs = { order: null, hidden: null };

/// Every id an order may mention: the strip-eligible views, gating
/// aside. A stored order outlives the build that wrote it, so an id
/// dropped from here would quietly move that tab to the end of the next
/// session's strip.
export function orderableHubViewIds(): string[] {
  return HUB_VIEW_META.filter((v) => !v.viaAction).map((v) => v.id);
}

/// The rows the two settings panels list. A view reached by a button has
/// no tab to take away, so it does not belong in a list whose only
/// control is "show this or don't".
export function manageableHubViewIds(): string[] {
  return HUB_VIEW_META.filter((v) => !v.viaAction).map((v) => v.id);
}

/// A stored order applied to the ids a workspace actually offers. Ids
/// the order never mentions keep their declaration order and follow the
/// ones it does, so a tab added by a later gavin appears at the end
/// rather than at some position the human never chose.
export function orderHubViewIds(ids: string[], order: string[] | null): string[] {
  if (!order || order.length === 0) return ids;
  const rank = new Map(order.map((id, i) => [id, i]));
  // The fallback rank starts past the end of the stored order and keeps
  // the natural index, so unmentioned ids stay in declaration order
  // among themselves and every key is distinct -- the sort never has to
  // be stable to be predictable.
  return ids
    .map((id, i) => ({ id, rank: rank.get(id) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.id);
}

/// Moves one tab next to another, returning a FULL order over every
/// orderable id -- not just the ones on screen when the drag happened.
/// A workspace with no root draws one tab; storing only that one would
/// forget where the other eight sat the moment a root was bound.
export function moveHubViewId(
  order: string[] | null,
  draggedId: string,
  targetId: string,
  position: "before" | "after"
): string[] {
  const full = orderHubViewIds(orderableHubViewIds(), order);
  if (draggedId === targetId) return full;
  const without = full.filter((id) => id !== draggedId);
  const at = without.indexOf(targetId);
  if (at < 0 || !full.includes(draggedId)) return full;
  const index = position === "before" ? at : at + 1;
  return [...without.slice(0, index), draggedId, ...without.slice(index)];
}

/// Flips one view's eye. Returns the new hidden list; an absent list is
/// read as "nothing hidden", which is what the first click on an
/// inheriting workspace has to start from.
export function toggleHubViewHidden(hidden: string[] | null, id: string): string[] {
  const current = hidden ?? [];
  return current.includes(id) ? current.filter((h) => h !== id) : [...current, id];
}

/// Whether a panel may still take this view away. The last one standing
/// may not be hidden: a strip with nothing in it is a row of nothing at
/// the top of the window, and every ⌘-digit would address no tab at all.
/// Asked of the MANAGEABLE list rather than of one workspace's strip, so
/// the answer does not change with which workspace happens to be open.
export function canHideHubView(hidden: string[] | null, id: string): boolean {
  if ((hidden ?? []).includes(id)) return true;
  return manageableHubViewIds().filter((v) => !(hidden ?? []).includes(v)).length > 1;
}

/// Every hub view a given workspace offers, in the order they render --
/// including the ones reached by a button rather than a tab. This is the
/// "is this view on offer here" question: what resolveHubView may land
/// on, and what the sidebar's recap chips may jump to.
///
/// Deliberately blind to `HubTabPrefs`: hiding a tab takes it out of the
/// strip, not out of the app. A chip that jumps to the board still opens
/// the board.
export function visibleHubViewIds(hasRoot: boolean): string[] {
  return HUB_VIEW_META.filter((v) => hubViewIsVisible(v, hasRoot)).map((v) => v.id);
}

/// The subset that renders as a tab, in strip order.
///
/// Separate from visibleHubViewIds because the ⌘-digit router addresses
/// tabs BY POSITION: it and the strip have to count the same things, or
/// the badge a tab wears while ⌘ is held opens a different tab. That is
/// also why the human's own order and hidden set are applied HERE and
/// nowhere else -- one derivation, so a dragged tab and its digit move
/// together.
export function tabStripHubViewIds(hasRoot: boolean, prefs: HubTabPrefs = NO_HUB_TAB_PREFS): string[] {
  const offered = HUB_VIEW_META.filter((v) => !v.viaAction && hubViewIsVisible(v, hasRoot)).map(
    (v) => v.id
  );
  const ordered = orderHubViewIds(offered, prefs.order);
  const hidden = new Set(prefs.hidden ?? []);
  const shown = ordered.filter((id) => !hidden.has(id));
  // The panels already refuse to hide the last manageable view, but that
  // guarantee is about the whole list, not about one workspace: the root
  // gate has cut this strip down first. Hiding Git and Home leaves an
  // unbound workspace with Kanban alone, and hiding Kanban as well --
  // legal, because Git and Home are still shown SOMEWHERE -- would leave
  // it with none. A hidden set that empties this particular strip is
  // ignored rather than obeyed.
  return shown.length > 0 ? shown : ordered;
}

/// What a hub tab can be busy WITH. One field today -- the Git tab's
/// hidden commit agent -- but shaped as a bag so the next background run
/// that wants a tab to say so adds a field rather than a second
/// mechanism.
export interface HubViewActivity {
  /// A "Commit via agent" run in flight in this workspace.
  committing: boolean;
  /// A rail in this workspace has a running step waiting on a HUMAN --
  /// an agent asking a question, or one whose turn ended without its card
  /// reaching the done column (see stepAttentions).
  railsWantingAttention: boolean;
}

/// Whether this tab should say, from the tab strip, that something it
/// owns is running right now. A hidden run has no tab and no window of
/// its own, so the tab that launched it is the only place the app can
/// admit it exists while the human is looking at some other tab.
export function hubViewBusy(viewId: string, activity: HubViewActivity): boolean {
  return viewId === "git" && activity.committing;
}

/// Whether this tab should say, from the tab strip, that something it
/// owns is waiting on the HUMAN. A separate axis from `hubViewBusy` on
/// purpose, and never collapsed into it: a spinner says gavin is doing
/// something, a mark says you have to. A rail can be both at once.
export function hubViewAttention(viewId: string, activity: HubViewActivity): boolean {
  return viewId === "orchestration" && activity.railsWantingAttention;
}

/// The hub tab to land on when a workspace's Hub button is clicked: the
/// one it was last showing, or -- when nothing is remembered, or the
/// remembered tab is no longer offered (its root was unbound, or the
/// human hid the tab) -- the first tab its strip does draw.
export function resolveHubView(ws: Workspace, prefs: HubTabPrefs = NO_HUB_TAB_PREFS): string {
  const strip = tabStripHubViewIds(Boolean(ws.rootPath), prefs);
  // Settings is kept as remembered even though it is not in the strip:
  // hiding cannot reach a view that has no tab, so landing back on the
  // gear is landing back somewhere that is still there.
  const offered = visibleHubViewIds(Boolean(ws.rootPath));
  const keepable = new Set([...strip, ...offered.filter((id) => VIA_ACTION_IDS.has(id))]);
  return ws.hubView && keepable.has(ws.hubView) ? ws.hubView : strip[0];
}
