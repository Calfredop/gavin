// A card being DEVELOPED, as pure decisions: which card a run holds, when
// that run is over, and what every other surface is allowed to do to the
// card meanwhile. No Svelte, no Tauri, no I/O -- developingCardsState.ts
// owns the effects (record, sweep, reveal), the same split
// orchestrationAgent.ts and orchestrationState.ts use.
//
// Why a card needs deactivating at all: "Develop into a plan…" spawns an
// agent whose job is to REWRITE the card file -- a new body, a new kind,
// sometimes a set of nested children. It deliberately writes no status and
// binds no session (developing is not starting), which is what left the
// board with nothing to show: the card sat there looking idle, offering
// Run, Start all, Run on several agents and a rail step, every one of
// which would hand a second agent a file about to be replaced under it.
// The first agent's interview and the second agent's edits then land in
// the same file, and one of the two is simply lost.
//
// So the record is the indication AND the lock: one fact, read by the
// badge that says what is happening and by every launch that must not.

import type { SessionStatus } from "$lib/core/notifications";
import type { DevelopingCardRecord, SessionLiveness, WorkspacesData } from "$lib/core/workspace";
import type { GavinTree } from "$lib/core/gavin";
import { cardViewForPath } from "$lib/core/planBoard";

/// The run developing this card, or null. Path equality, the same key
/// `cardSessionFor` matches on. A develop run writes no status of its
/// own, so the path it starts on is normally the path it ends on; a human
/// who files or archives the card mid-run re-keys the file out from under
/// the record, which leaves the lock pointing at a path no card has any
/// more -- harmless (there is nothing there to launch), and the sweep
/// clears it when the run ends either way.
export function developingRunFor(
  records: readonly DevelopingCardRecord[] | undefined,
  path: string
): DevelopingCardRecord | null {
  return records?.find((r) => r.path === path) ?? null;
}

/// The same lookup starting from the app's workspaces, for the templates
/// that already read `$layoutState` and would otherwise each re-derive the
/// two-step walk. The records live ON the workspace (they persist with it),
/// so there is no second copy anywhere to disagree with this one.
export function developingRunIn(
  state: Pick<WorkspacesData, "workspaces">,
  workspaceId: string,
  path: string
): DevelopingCardRecord | null {
  return developingRunFor(
    state.workspaces.find((w) => w.id === workspaceId)?.developingCards,
    path
  );
}

/// The card's mtime as the tree reports it right now, written into the
/// record when the run starts so the sweep can tell the agent's write
/// from the interview before it. Null when the tree has not got the card
/// or the daemon sent no mtime -- the record then falls back to the
/// older rule (developRunOver).
export function developBaseline(tree: GavinTree | undefined, path: string): number | null {
  return cardViewForPath(tree, path)?.modifiedAt ?? null;
}

/// HAS THE AGENT WRITTEN THE CARD YET? The develop skill writes nothing
/// until the human has said yes to the whole proposal, so a card file
/// still at its launch mtime means the run is still in its interview,
/// however quiet the agent has gone in the meantime.
///
///  - No baseline (a record an older build wrote, or a card the tree did
///    not have at launch) answers true: nothing to compare against, so
///    the sweep keeps the rule it had before the baseline existed.
///  - No tree yet (the app is still loading it) answers false. Not known
///    is not written.
///  - The card gone from a loaded tree answers true: it was filed,
///    archived or renamed, and there is no file left at this path to
///    protect.
///
/// The human's own edits count too -- a drag that rewrites `order:`
/// bumps the mtime the same way. That frees the card at the agent's next
/// quiet moment, which is the old behaviour and not a lost write: the
/// interview has not written anything yet for a second run to collide
/// with.
export function developWriteSeen(
  record: DevelopingCardRecord,
  tree: GavinTree | undefined
): boolean {
  if (record.baselineModifiedAt == null) return true;
  if (!tree) return false;
  const card = cardViewForPath(tree, record.path);
  if (!card) return true;
  return card.modifiedAt != null && card.modifiedAt > record.baselineModifiedAt;
}

/// IS THE RUN OVER? Deliberately the same three signals as an
/// orchestration agent's (orchestrationAgent.ts owns the long version of
/// this reasoning), because it is the same kind of run: a one-shot request
/// to an INTERACTIVE agent, which never exits -- it sits at its prompt
/// forever once the work is done, so there is no exit code to wait for.
///
///  - `gone` -- the session left the layout, so the run left with it.
///  - `interrupted` -- a daemon restart killed the agent and put a bare
///    shell back wearing its id.
///  - `idle` AFTER the card was written (developWriteSeen) -- the agent
///    wrote the plan and stopped talking, which is the finish line.
///
/// Idle on its own is not enough, and that is the common case rather
/// than an edge: the develop agent's FIRST move is to interview the
/// human, and a question asked in prose leaves it idle -- the daemon
/// reads two quiet seconds as idle, not as waiting. Freeing the card
/// there unlocked it for the entire length of the conversation that
/// decides what it says, which is what the badge used to do: it showed
/// for the few seconds the agent spent reading, then vanished.
///
/// An ABSENT status is NOT idle either. The daemon registers a new
/// session idle and only pushes on a change, so "nothing reported yet"
/// arrives as `undefined`; reading that as idle would free the card in
/// the very tick its develop run launched.
///
/// A run that never writes -- the human walked away from the interview,
/// or told the agent to leave the card alone -- holds until its tab is
/// closed or the human presses Finish developing (finishDeveloping).
export function developRunOver(
  liveness: SessionLiveness,
  status: SessionStatus | undefined,
  written: boolean
): boolean {
  if (liveness !== "live") return true;
  return written && status === "idle";
}

/// Why nothing may be launched on this card, phrased for the surface that
/// has to refuse -- the board's error strip, the card detail, a run pill's
/// tooltip. Says what is happening first, because "developing" is a state
/// the human may not have known the card was in.
export const DEVELOPING_BLOCK =
  "An agent is developing this card — it is rewriting the file, so nothing " +
  "else can run it until that finishes. Jump to its tab to see where it got to.";

/// The same refusal for an orchestration rail's step chip, which has room
/// for a clause and not a sentence. A stall, never a failure: the rail
/// picks the step back up once the develop run ends.
export const DEVELOPING_STALL = "the card is being developed";

/// What a press of "Develop into a plan…" does when one is already going:
/// jump to the tab rather than start a second run on the same card. Two
/// develop agents on one card is the worst version of the conflict this
/// module exists for -- both of them rewrite the whole file.
export const DEVELOPING_MENU_LABEL = "Developing — jump to its tab";

/// The way out of a lock the sweep cannot see the end of: an agent that
/// was told to leave the card alone, an interview abandoned half way, a
/// card the human finished by hand. Frees the card and leaves the
/// agent's tab alone -- closing a session is the human's own act.
export const FINISH_DEVELOPING_LABEL = "Finish developing — free this card";
