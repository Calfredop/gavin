/// Running an approved delete: the disk, then the daemon, then the app.
///
/// Kept apart from `workspaceDelete.ts`, which decides nothing but WHAT
/// would happen. This module is the only place that acts, and the order
/// it acts in is the design:
///
///   1. the files, through Rust;
///   2. the daemon's rows, through the ordinary requests that already
///      exist for each of them (no protocol change: every row this
///      clears is reachable today);
///   3. the workspace itself, and only if the first two left nothing
///      behind. A partial run keeps the workspace so the wizard can be
///      reopened and finished, rather than removing the one handle the
///      user has on what is left.

import * as backend from "$lib/backend";
import { deleteWorkspaceFromApp } from "$lib/layoutState";
import { plannedRemovals, touchesDisk, type DeleteAnswers, type GavinFootprint } from "$lib/workspaceDelete";

export interface DeleteResult {
  /// Everything that landed, in the order it happened.
  done: string[];
  /// `[what, why]` for everything that did not.
  failed: Array<[string, string]>;
  /// Whether the workspace left the app. False whenever anything failed.
  removed: boolean;
}

/// Clears every daemon row keyed to this workspace.
///
/// The order matters in one place only: `unlink_card_session` needs the
/// card list, and the board is where that list lives, so the links go
/// before the board does. (`delete_board` leaves `card_sessions` behind
/// -- clearing the board is not enough on its own, which is exactly the
/// kind of thing a "just delete the board" shortcut would miss.)
///
/// Tools and group templates are filtered to this workspace's own.
/// A row with `workspaceId: null` is a GLOBAL, shared with every other
/// workspace on the machine; deleting one because a workspace was
/// deleted would take somebody else's library with it.
async function clearDaemonRows(
  workspaceId: string,
  done: string[],
  failed: Array<[string, string]>
): Promise<void> {
  const attempt = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      done.push(what);
    } catch (e) {
      failed.push([what, String(e instanceof Error ? e.message : e)]);
    }
  };

  let cardPaths: string[] = [];
  try {
    cardPaths = (await backend.getBoard(workspaceId)).cardSessions.map((c) => c.path);
  } catch (e) {
    failed.push(["card session links", String(e instanceof Error ? e.message : e)]);
  }
  for (const path of cardPaths) {
    await attempt(`Unlinked the session from ${path}`, () =>
      backend.unlinkCardSession(workspaceId, path)
    );
  }

  await attempt("Cleared the rails and run state", () =>
    backend.setOrchestration(workspaceId, [], [])
  );

  try {
    const tools = await backend.getTools(workspaceId);
    for (const tool of tools.filter((t) => t.workspaceId === workspaceId)) {
      await attempt(`Deleted the tool "${tool.name}"`, () => backend.deleteTool(tool.id));
    }
  } catch (e) {
    failed.push(["workspace tools", String(e instanceof Error ? e.message : e)]);
  }

  try {
    const templates = await backend.getGroupTemplates(workspaceId);
    for (const t of templates.filter((t) => t.workspaceId === workspaceId)) {
      await attempt(`Deleted the group template "${t.name}"`, () =>
        backend.deleteGroupTemplate(t.id)
      );
    }
  } catch (e) {
    failed.push(["group templates", String(e instanceof Error ? e.message : e)]);
  }

  // Last: the columns and labels themselves.
  await attempt("Cleared the board's columns and labels", () => backend.deleteBoard(workspaceId));
}

/// `token` is the wizard's grant from `confirmGate.ts`, minted over
/// `footprint.root` when the human typed the workspace name on the last
/// screen. The six screens ARE the confirmation for this command, and a
/// direct `invoke` used to skip all six (AS-05/R5).
export async function executeWorkspaceDelete(
  workspaceId: string,
  footprint: GavinFootprint,
  answers: DeleteAnswers,
  token: string
): Promise<DeleteResult> {
  const plan = plannedRemovals(footprint, answers);
  const done: string[] = [];
  const failed: Array<[string, string]> = [];

  if (touchesDisk(plan)) {
    try {
      const report = await backend.removeGavinFootprint(
        footprint.root,
        { trash: plan.trash, stripMcpKey: plan.stripMcpKey, cutBlock: plan.cutBlock },
        token
      );
      done.push(...report.done);
      failed.push(...report.failed);
    } catch (e) {
      // The command itself refusing (a root that has moved, say) is one
      // failure for the whole file half, not one per path.
      failed.push([footprint.root, String(e instanceof Error ? e.message : e)]);
    }
  }

  if (plan.rows) await clearDaemonRows(workspaceId, done, failed);

  if (failed.length > 0) return { done, failed, removed: false };

  await deleteWorkspaceFromApp(workspaceId);
  done.push("Removed the workspace from gavin");
  return { done, failed, removed: true };
}
