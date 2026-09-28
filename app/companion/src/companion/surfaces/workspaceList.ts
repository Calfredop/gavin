// The workspace list: one row per workspace on the Workstation, saying
// what is happening there.
//
// Everything a row says is the desktop's own arithmetic -- the sidebar's
// tallies, the hub's recap line, the board's projection -- so a phone can
// never describe a workspace differently from the desk it belongs to.
// What is new here is only which of it a phone has room for.
import type { Board } from "$lib/board/kanban";
import type { GavinTree } from "$lib/core/gavin";
import { normalizeColor } from "$lib/core/settings";
import { pinnedFirst, type Workspace } from "$lib/core/workspace";
import { workspaceRecapLine } from "$lib/hub/appHub";
import {
  kanbanColumnChips,
  kanbanSummary,
  workspaceAgentsSummary,
  type KanbanColumnChip,
  type PageTabState,
} from "$lib/sidebar/sidebarSummary";

export interface WorkspaceListInput {
  workspaces: Workspace[];
  boards: Record<string, Board>;
  trees: Record<string, GavinTree>;
  /// The statuses as the attention surfaces read them, and the three
  /// maps that say which of a page's tabs are not agents at all.
  tabs: PageTabState;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  color: string;
  /// The folder the workspace is bound to, or null for one bound to
  /// none -- which has terminals and no cards.
  folder: string | null;
  /// "1 running · 1 waiting · 2 pages".
  agents: string;
  /// Agents waiting on the human: the row's badge.
  waiting: number;
  /// Agents that stopped because something broke.
  failed: number;
  /// One count per column, in board order.
  columns: KanbanColumnChip[];
  cards: number;
  /// Whether the counts are in hand. False draws no counts at all: a
  /// zero nobody has read yet is not "no cards".
  loaded: boolean;
}

export function workspaceRows(input: WorkspaceListInput): WorkspaceRow[] {
  return pinnedFirst(input.workspaces).map((ws): WorkspaceRow => {
    const agents = workspaceAgentsSummary(ws, input.tabs);
    const folder = ws.rootPath?.trim() || null;
    const board = folder ? input.boards[ws.id] : undefined;
    const cards = kanbanSummary(board, input.trees[ws.id]);
    return {
      id: ws.id,
      name: ws.name,
      color: normalizeColor(ws.color),
      folder,
      agents: workspaceRecapLine(agents),
      waiting: agents.waiting,
      failed: agents.failed,
      columns: board ? kanbanColumnChips(cards) : [],
      cards: cards.total,
      loaded: folder === null || board !== undefined,
    };
  });
}
