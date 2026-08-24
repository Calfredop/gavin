// Archiving and un-archiving cards: the write side of the archive, kept
// out of archive.ts so that module stays a pure projection.
//
// Same contract as cardDelete.ts's flows, deliberately: sequential,
// patch-on-success, stop on the first failure and name the file. The
// daemon answers with the path the card landed on, and that path is the
// card's identity everywhere -- the open modal, the board selection, a
// rail step -- so it is patched into the tree immediately rather than
// waited for from the watcher ~170ms later.

import { confirm } from "@tauri-apps/plugin-dialog";
import { get } from "svelte/store";
import * as backend from "./backend";
import { patchPlanPath } from "./gavinState";
import { kanbanState, refreshBoard } from "./kanbanState";
import { layoutState, closeSession } from "./layoutState";
import {
  closablesForArchive,
  liveSessionTotal,
  archiveClosePrompt,
  type ArchiveClosables,
} from "./archiveClose";
import { slugStatus, type CardView } from "./planBoard";

/// Archiving a plan moves its nested children on disk too, so their
/// paths change without the app ever asking. Listing them here keeps the
/// tree honest between the write and the watcher's confirmation.
function movedPaths(card: CardView, destDir: string): Array<{ from: string; to: string }> {
  return [card, ...card.nestedChildren].map((c) => ({
    from: c.id,
    to: `${destDir}/${c.fileName}`,
  }));
}

/// The folder a card sits in — its path minus the file name.
function dirOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

async function moveOne(
  workspaceId: string,
  card: CardView,
  move: (path: string) => Promise<string>
): Promise<void> {
  const landed = await move(card.id);
  // The children followed daemon-side; re-point them at the folder the
  // parent actually landed in rather than the one we asked for, since
  // the daemon leaves a card put when its destination name is taken.
  for (const { from, to } of movedPaths(card, dirOf(landed))) {
    patchPlanPath(workspaceId, from, to);
  }
}

/// Ends what the card was using: its live agent sessions first, then the
/// pane tabs that were showing its file. Best-effort by design --
/// closeSession reports its own failure to the error strip, and a tab
/// that refused to close must not turn a finished archive into an error.
async function closeFor(closing: ArchiveClosables): Promise<void> {
  for (const id of [...closing.sessionIds, ...closing.fileTabIds]) {
    // Swallowed here, not left to the caller's catch: the card's file
    // has already moved by this point, so reporting "Couldn't archive
    // it" would name the one thing that did work.
    await closeSession(id).catch(() => {});
  }
}

/// `executeArchive`'s answer when the human cancelled at the "this will
/// close N agents" prompt: nothing moved, nothing failed, so it is not
/// an error -- but a caller that dismisses itself once the card is gone
/// has to tell "done" and "never started" apart.
///
/// Falsy on purpose: every existing `if (err) reportError(err)` call site
/// keeps reading it as "nothing to report" without knowing it exists.
export const ARCHIVE_CANCELLED = "";

/// Archives every card in `cards`, in order. Returns null on success,
/// ARCHIVE_CANCELLED when the human backed out of the prompt, or a
/// message naming the card that failed.
///
/// Archiving takes the card off the board, so it takes the card's
/// running agents and open tabs with it. The human is asked first, once
/// for the whole batch, but only when a LIVE session would end -- a file
/// tab ends no process, and a dialog for closing one would be noise.
export async function executeArchive(
  workspaceId: string,
  cards: CardView[]
): Promise<string | null> {
  // Computed while the cards still sit where every binding and file tab
  // says they do; the move rewrites those paths underneath us.
  const closables = closablesForArchive(get(layoutState), get(kanbanState)[workspaceId], cards);
  const sessions = liveSessionTotal(closables);
  if (sessions > 0) {
    const go = await confirm(archiveClosePrompt(cards.length, sessions), { title: "gavin" });
    // Cancelled: nothing moved, nothing closed, and nothing to report.
    if (!go) return ARCHIVE_CANCELLED;
  }
  let current = "";
  try {
    for (const [i, card] of cards.entries()) {
      current = card.id;
      await moveOne(workspaceId, card, backend.archiveCard);
      // Per card, after its own move landed -- a failure half-way
      // through leaves the untouched cards' sessions running.
      await closeFor(closables[i]);
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't archive ${fileName}: ${e instanceof Error ? e.message : e}`;
  } finally {
    // Bindings and rail steps were re-keyed daemon-side; the board store
    // still holds the old paths until it is refetched.
    void refreshBoard(workspaceId);
  }
}

/// The inverse. The card lands back in `plans/` or `plans/done/`
/// according to the status it kept while archived.
export async function executeUnarchive(
  workspaceId: string,
  cards: CardView[]
): Promise<string | null> {
  let current = "";
  try {
    for (const card of cards) {
      current = card.id;
      await moveOne(workspaceId, card, backend.unarchiveCard);
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't restore ${fileName}: ${e instanceof Error ? e.message : e}`;
  } finally {
    void refreshBoard(workspaceId);
  }
}

/// Whether this column is the one that carries the bulk archive button.
/// Matched by slug against the Done status, the same way the board
/// matches a card's status to a column name -- so "done" and " DONE "
/// are the same column, and a custom "Shipped" is not.
export function isDoneColumn(name: string): boolean {
  return slugStatus(name) === "done";
}
