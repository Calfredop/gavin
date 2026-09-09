// "Close Idle Tabs" -- the page context menu's one bulk close chosen by
// STATUS rather than by position. Pure: which of a page's tabs qualify,
// and what the prompt about to close them says. The close itself is
// tabActions' closeTabsNow.
//
// "Idle" here is exactly the sidebar recap's idle bucket
// (sidebarSummary's pageAgentsSummary): a terminal session that is
// neither working nor waiting on the human, a session that has never
// reported a status included. The page row already shows that number, so
// the menu has to act on that same set -- an entry that closed four tabs
// off a row reading "3 idle" would make both numbers untrustworthy.
import { allLeaves, allSessionIds, sessionTabsOnly } from "$lib/panes/layout";
import { count } from "$lib/railConfirm";
import type { PageTabState } from "$lib/sidebar/sidebarSummary";
import type { Page } from "$lib/workspace";

/// A page's tabs, split by what "Close Idle Tabs" would do to each. The
/// four buckets (`ids`, `pinned`, `busy`, `other`) partition the page:
/// every tab lands in exactly one, which is what lets the prompt account
/// for the tabs it is NOT closing without walking the tree again.
export interface IdleTabs {
  /// The idle session tabs the close acts on, in layout order.
  ids: string[];
  /// Idle session tabs left alone because they are pinned. Pinning is
  /// the app's one "keep this tab" gesture and every other bulk close
  /// (layout's bulkCloseTargets) honours it, so this one does too.
  pinned: string[];
  /// Session tabs that are working or waiting on the human.
  busy: number;
  /// File and board tabs. No agent runs behind one, so none of them is
  /// idle in any sense this entry could act on.
  other: number;
  /// Panes that lose every tab they hold, and so close with them.
  emptiedPanes: number;
  /// True when the close takes the last tab off the page -- which
  /// removes the PAGE (handleSessionExited falls through to removePage),
  /// not just its panes.
  emptiesPage: boolean;
}

export function idleTabsOnPage(page: Page, state: PageTabState): IdleTabs {
  const ids = allSessionIds(page.layout);
  const sessions = sessionTabsOnly(ids, state.fileTabsById, state.boardTabsById, state.cardTabsById);
  const idle = sessions.filter((id) => {
    const status = state.sessionStatusById[id];
    return status !== "working" && status !== "waiting_for_input";
  });
  const leaves = allLeaves(page.layout);
  const pinnedIds = new Set(leaves.flatMap((leaf) => leaf.pinned ?? []));
  const closing = idle.filter((id) => !pinnedIds.has(id));
  const closingSet = new Set(closing);
  return {
    ids: closing,
    pinned: idle.filter((id) => pinnedIds.has(id)),
    busy: sessions.length - idle.length,
    other: ids.length - sessions.length,
    emptiedPanes: leaves.filter((leaf) => leaf.tabs.length > 0 && leaf.tabs.every((id) => closingSet.has(id)))
      .length,
    emptiesPage: closing.length > 0 && closing.length === ids.length,
  };
}

/// What the confirmation asks, in the shape ConfirmPrompt renders. Built
/// here rather than in the sidebar so the counts a human agrees to come
/// from the very split the action uses, and so the copy can be tested
/// without a component -- the same discipline railConfirm.ts follows.
export interface CloseIdlePrompt {
  title: string;
  lines: string[];
  confirmLabel: string;
}

/// Every line after the first says what STAYS. A bulk close picked by
/// status is the one close where a human cannot see the target set --
/// the tabs are spread over panes, and some of them are on a page that
/// is not even on screen -- so the prompt has to account for every tab
/// it is leaving behind, or the count in the title is a number with
/// nothing to check it against.
export function closeIdlePrompt(page: Page, idle: IdleTabs): CloseIdlePrompt {
  const n = idle.ids.length;
  const lines = [
    `Ends ${count(n, "terminal session")} — idle means the agent is neither working nor waiting on you.`,
  ];
  const pinned = idle.pinned.length;
  if (idle.busy > 0)
    lines.push(
      `${count(idle.busy, "tab")} working or waiting on you ${idle.busy === 1 ? "stays" : "stay"} open.`
    );
  if (pinned > 0)
    lines.push(
      `${count(pinned, "pinned tab")} ${pinned === 1 ? "is" : "are"} idle too and ${pinned === 1 ? "stays" : "stay"} — unpin to include ${pinned === 1 ? "it" : "them"}.`
    );
  if (idle.other > 0)
    lines.push(
      `${count(idle.other, "file or board tab")} ${idle.other === 1 ? "stays" : "stay"} — no agent runs behind ${idle.other === 1 ? "it" : "them"}.`
    );
  // The page's own disappearance outranks the pane note: when the last
  // tab goes the page goes, and saying "2 panes close too" about a page
  // that will not be there is the wrong headline.
  if (idle.emptiesPage) lines.push(`That is every tab on this page — the page closes with them.`);
  else if (idle.emptiedPanes > 0)
    lines.push(
      `${count(idle.emptiedPanes, "pane")} ${idle.emptiedPanes === 1 ? "is" : "are"} left empty and ${idle.emptiedPanes === 1 ? "closes" : "close"} too.`
    );
  return {
    title: `Close ${count(n, "idle tab")} on "${page.name}"?`,
    lines,
    confirmLabel: `Close ${count(n, "tab")}`,
  };
}

/// What the menu hands the sidebar: the frozen id list and the copy that
/// describes it. Frozen deliberately -- an agent can change status while
/// the prompt is open, and a human who agreed to "close 3 tabs" must not
/// get 2, or 4.
export interface CloseIdleRequest {
  ids: string[];
  prompt: CloseIdlePrompt;
}
