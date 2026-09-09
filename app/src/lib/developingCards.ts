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

import type { SessionStatus } from "$lib/notifications";
import type { DevelopingCardRecord, SessionLiveness, WorkspacesData } from "$lib/workspace";

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

/// IS THE RUN OVER? Deliberately the same three signals as an
/// orchestration agent's (orchestrationAgent.ts owns the long version of
/// this reasoning), because it is the same kind of run: a one-shot request
/// to an INTERACTIVE agent, which never exits -- it sits at its prompt
/// forever once the work is done, so there is no exit code to wait for.
///
///  - `gone` -- the session left the layout, so the run left with it.
///  - `interrupted` -- a daemon restart killed the agent and put a bare
///    shell back wearing its id.
///  - `idle` -- the agent stopped talking, which for a one-shot request is
///    the finish line.
///
/// An ABSENT status is NOT idle. The daemon registers a new session idle
/// and only pushes on a change, so "nothing reported yet" arrives as
/// `undefined`; reading that as idle would free the card in the very tick
/// its develop run launched, and the lock would never hold at all.
///
/// `waiting_for_input` is not idle either, and here that is the common
/// case rather than an edge: the develop agent's FIRST move is to
/// interview the human. Freeing the card there would unlock it for the
/// entire length of the conversation that decides what it says.
export function developRunOver(
  liveness: SessionLiveness,
  status: SessionStatus | undefined
): boolean {
  if (liveness !== "live") return true;
  return status === "idle";
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
