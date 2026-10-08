// A workspace's sessions, as a phone lists them: every terminal the desk
// has open there, page by page, and what each agent is doing.
//
// Which tabs are sessions, what each is called and what its badge says
// are the desktop's rules, read through the desktop's functions -- the
// tab strip's label (`sessionLabel`), the page recap's projection
// (`sessionTabsOnly`), the badge vocabulary (`indicators.ts`) -- so a
// session cannot go by one name on the phone and another at the desk.
import type { SessionStatus } from "$lib/core/notifications";
import { folderName, sessionLabel } from "$lib/core/paths";
import type { Workspace } from "$lib/core/workspace";
import type { TabMaps } from "$lib/panes/tabIdentity";
import { allSessionIds, sessionTabsOnly } from "$lib/panes/layout";
import {
  agentFailedIndicator,
  agentIndicator,
  agentInterruptedIndicator,
  type Indicator,
} from "$lib/ui/indicators";

export interface SessionRow {
  id: string;
  name: string;
  /// The folder it is in, when its name is not already that.
  folder: string | null;
  status: SessionStatus;
  badge: Indicator;
  /// What the badge says, in its own words without the axis: "working",
  /// "waiting for you", "stopped — <the agent's sentence>".
  said: string;
}

export interface SessionGroup {
  key: string;
  title: string;
  rows: SessionRow[];
  /// The workspace agent's group with no agent in it: the place to start
  /// one, as the desk's Home tab offers.
  startAgent?: true;
}

export interface SessionListInput {
  workspace: Workspace;
  tabs: TabMaps;
  /// The statuses the attention surfaces read: a wait the human marked
  /// as read is quiet, a question asked in prose is a wait.
  statusById: Record<string, SessionStatus>;
  sessionNames: Record<string, string>;
  cwdBySessionId: Record<string, string>;
  failureReasonById: Record<string, string>;
  interruptedSessionIds: ReadonlySet<string>;
  /// Sessions this Device started in the workspace that the desk has not
  /// placed on a page (yet): the phone's own, until the desk shows them.
  startedHere: readonly string[];
  /// The workspace agent this Device started there, if any: the agent
  /// until the desk records one, which it does as it places the session.
  agentStartedHere?: string;
}

/// An indicator's words after its axis ("Agent · working" → "working").
/// The badge vocabulary is indicators.ts's, and a row repeating it in
/// its own words would be a second one.
export function detailOf(indicator: Indicator): string {
  const at = indicator.tip.indexOf(" · ");
  return at === -1 ? indicator.tip : indicator.tip.slice(at + " · ".length);
}

function row(input: SessionListInput, id: string): SessionRow {
  const name = sessionLabel(input.sessionNames, input.cwdBySessionId, id);
  const cwd = input.cwdBySessionId[id];
  const folder = cwd ? folderName(cwd) : null;
  const status = input.statusById[id] ?? "idle";
  const badge = input.interruptedSessionIds.has(id)
    ? agentInterruptedIndicator()
    : status === "failed"
      ? agentFailedIndicator(input.failureReasonById[id])
      : agentIndicator(status);
  return { id, name, folder: folder === name ? null : folder, status, badge, said: detailOf(badge) };
}

/// The workspace's sessions in groups: its own agent, then each page's
/// terminals in the order the desk's tab strip has them, then the ones
/// this Device started and no page holds. A page of files and boards only
/// is not a group, and no session is listed twice.
///
/// A workspace with a folder always has its agent's group: the agent, or
/// with none, the place to start one -- the desk's Home tab offers the
/// same, and only for a workspace with a folder, since that is where the
/// agent works.
export function sessionGroups(input: SessionListInput): SessionGroup[] {
  const { workspace } = input;
  const seen = new Set<string>();
  const take = (ids: string[]): SessionRow[] => {
    const rows: SessionRow[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row(input, id));
    }
    return rows;
  };

  const groups: SessionGroup[] = [];
  const pageIds = new Set(workspace.pages.flatMap((p) => allSessionIds(p.layout)));
  const pending = input.agentStartedHere && !pageIds.has(input.agentStartedHere) ? input.agentStartedHere : undefined;
  const main = workspace.mainSessionId ?? pending;
  if (main && !pageIds.has(main)) {
    groups.push({ key: "main", title: "Workspace agent", rows: take([main]) });
  } else if (!main && workspace.rootPath?.trim()) {
    groups.push({ key: "main", title: "Workspace agent", rows: [], startAgent: true });
  }
  for (const page of workspace.pages) {
    const ids = sessionTabsOnly(
      allSessionIds(page.layout),
      input.tabs.fileTabsById,
      input.tabs.boardTabsById,
      input.tabs.cardTabsById
    );
    const rows = take(ids);
    if (rows.length > 0) groups.push({ key: `page:${page.id}`, title: page.name, rows });
  }
  const own = take(input.startedHere.filter((id) => !pageIds.has(id) && id !== main));
  if (own.length > 0) groups.push({ key: "started-here", title: "Started from this phone", rows: own });
  return groups;
}

/// Every session a workspace's list can show, whatever its group.
export function workspaceSessionIds(workspace: Workspace, tabs: TabMaps): string[] {
  const ids = workspace.pages.flatMap((p) =>
    sessionTabsOnly(allSessionIds(p.layout), tabs.fileTabsById, tabs.boardTabsById, tabs.cardTabsById)
  );
  return workspace.mainSessionId ? [workspace.mainSessionId, ...ids] : ids;
}
