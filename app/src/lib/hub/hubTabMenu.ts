// The hub tab strip's right-click menu: take this tab away, put a
// hidden one back, or open the full list. Pure -- state in, entries out,
// writes through injected hooks -- so the row stays a template and these
// rules have a test that mounts nothing.
//
// Only offered while the strip is UNLOCKED, which the row enforces
// before it calls in here. The padlock is already the answer to "may
// this row be rearranged"; hiding is the same kind of edit as dragging,
// and putting it behind the same latch means a right-click on a tab is
// either a menu about arranging the row or nothing at all -- never a
// menu whose entries depend on a mode the human forgot they were in.
//
// The other way to reach all of this is the eye list in Settings
// (HubTabsModal). This menu is the shortcut, not a second source of
// truth: both write through setWorkspaceHubTabsHidden, and the last
// entry opens that panel, so the gesture always has somewhere to lead.
import type { ContextMenuEntry } from "$lib/contextMenu";
import {
  HUB_VIEW_META,
  canHideHubView,
  orderHubViewIds,
  tabStripHubViewIds,
  toggleHubViewHidden,
  visibleHubViewIds,
} from "$lib/hub/hubViewMeta";
import { hubLabel } from "$lib/workspace";

export interface HubTabMenuContext {
  /// The tab the menu was opened on. Always one the strip is drawing,
  /// so it is never already hidden.
  viewId: string;
  /// Whether the workspace has a bound root, which is what decides how
  /// many of the sections it offers at all.
  hasRoot: boolean;
  /// This strip's EFFECTIVE hidden set -- the workspace's own list, or
  /// the app-wide default it is inheriting. Starting from what the row
  /// actually draws is what makes the first hide on an inheriting
  /// workspace keep everything else it was already showing.
  hidden: string[];
  order: string[] | null;
  /// What this workspace's agent-file tab is called, since the label is
  /// the agent's file name rather than a fixed string.
  agentFile: string;
}

export interface HubTabMenuHooks {
  /// Stores the new hidden set for THIS workspace. Never the app-wide
  /// default: the gesture happened in one strip, and silently
  /// rearranging the other four is a much larger blast radius than a
  /// right-click looks like it has.
  setHidden: (hidden: string[]) => void;
  /// Opens the eye list, where the whole set -- including the sections a
  /// rootless workspace cannot offer -- can be turned back on.
  manage: () => void;
}

function labelFor(id: string, agentFile: string): string {
  const meta = HUB_VIEW_META.find((v) => v.id === id);
  return meta ? hubLabel(meta, agentFile) : id;
}

export function buildHubTabMenuEntries(
  ctx: HubTabMenuContext,
  hooks: HubTabMenuHooks
): ContextMenuEntry[] {
  const prefs = { order: ctx.order, hidden: ctx.hidden };
  const shown = tabStripHubViewIds(ctx.hasRoot, prefs);
  // Two guards, and neither implies the other. canHideHubView protects
  // the MANAGEABLE list -- the same rule the eye list obeys, so the last
  // section overall cannot be turned off from either place. `shown`
  // protects THIS strip: the root gate has already cut it down, and a
  // workspace with no root draws one tab out of a list where nine others
  // are still nominally showing. Hiding that one would be legal by the
  // first rule and would empty the row, which tabStripHubViewIds answers
  // by ignoring the hidden set entirely -- a menu entry that appears to
  // do nothing. Refusing is the honest version.
  const canHide = shown.length > 1 && canHideHubView(ctx.hidden, ctx.viewId);

  const entries: ContextMenuEntry[] = [
    {
      label: `Hide ${labelFor(ctx.viewId, ctx.agentFile)}`,
      disabled: !canHide,
      onPick: () => hooks.setHidden(toggleHubViewHidden(ctx.hidden, ctx.viewId)),
    },
  ];

  // Undo, in the place the hiding happened. Without it the gesture is
  // one-way from the strip and the only way back is a panel two clicks
  // into Settings -- which is how a human ends up with a tab they cannot
  // find. Listed in strip order, so a restored tab comes back where the
  // row says it will.
  //
  // Only the ones this workspace could actually draw: offering "Show
  // Git" to a workspace with no root would un-hide a tab that still does
  // not appear. Those stay reachable from the panel below.
  const offered = new Set(visibleHubViewIds(ctx.hasRoot));
  const restorable = orderHubViewIds(
    ctx.hidden.filter((id) => offered.has(id)),
    ctx.order
  );
  if (restorable.length > 0) {
    entries.push({ separator: true });
    for (const id of restorable) {
      entries.push({
        label: `Show ${labelFor(id, ctx.agentFile)}`,
        onPick: () => hooks.setHidden(toggleHubViewHidden(ctx.hidden, id)),
      });
    }
  }

  entries.push({ separator: true }, { label: "Hub tabs…", onPick: hooks.manage });
  return entries;
}
