// Doing what the task manager offers: jumping to a session, ending one,
// ending all of them, and restarting the daemon that holds them.
//
// The write side of sessionsManager.ts, kept out of that module so the
// arithmetic and the wording stay a pure, testable projection. Every
// destructive path here goes through a confirmation built there, so the
// panel cannot ask more softly than the text those tests pin down.
//
// The prompts are dialog.ts's own, never @tauri-apps/plugin-dialog. That
// plugin is capability-narrowed to the file picker, so its confirm()
// rejects at the permission layer before anything is drawn -- and an
// awaited rejection inside a `void`-ed click handler is a button that
// does nothing at all. "Kill all does nothing" was exactly that.

import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import { restartOutcome, type DaemonCompat } from "$lib/core/daemonCompat";
import { askConfirm, showAlert } from "$lib/core/dialog";
import {
  handleAgentSessionSpawned,
  handleOrphanEnded,
  handleSessionExited,
  layoutState,
  restartDaemonInPlace,
  switchToSessionInPage,
  switchWorkspaceView,
} from "$lib/core/layoutState";
import { findSessionLocation } from "$lib/core/workspace";
import { confirmDestructive, DAEMON_SUBJECT } from "$lib/core/confirmGate";
import {
  idleSessions,
  killBatchConfirm,
  killConfirm,
  killFailedAlert,
  killPlan,
  refusedOrphanAlert,
  restartConfirm,
  restartFailedAlert,
  restartOutcomeAlert,
  survivorsAlert,
  type KillScope,
  type SessionRow,
} from "$lib/sessions/sessionsManager";

/// Put the human in front of a session, giving it a tab first if nothing
/// is showing it.
///
/// The hidden case is the reason this exists. A git-commit run, an
/// orchestration Organize, a session left behind by a closed page: they
/// are real sessions doing real work with nowhere to watch them, and
/// `handleAgentSessionSpawned` is the app's one way to adopt such a
/// session onto a page (the workspace's "Agents" page, created if
/// absent) -- the same path the Git tab's "watch this run" button uses.
///
/// Returns false when the jump could not happen: no open workspace claims
/// the session, so there is no page anywhere to put it on. The panel says
/// so rather than appearing to do nothing.
export async function jumpToSession(row: SessionRow): Promise<boolean> {
  const state = get(layoutState);
  if (!findSessionLocation(state, row.id)) {
    const owner =
      state.workspaces.find((w) => w.mainSessionId === row.id) ??
      state.workspaces.find((w) => w.name === row.workspaceName);
    // The main agent panel is already on screen and lives outside every
    // page tree, so adopting it onto a page would MOVE it out of the
    // panel that owns it. Its home is the Home tab.
    if (owner?.mainSessionId === row.id) {
      await switchWorkspaceView(owner.id, "hub");
      return true;
    }
    if (!owner) return false;
    handleAgentSessionSpawned(owner.id, row.id);
  }
  const at = findSessionLocation(get(layoutState), row.id);
  if (!at) return false;
  await switchWorkspaceView(at.workspaceId, "terminal");
  await switchToSessionInPage(at.workspaceId, at.pageId, row.id);
  return true;
}

/// Ends one row, after asking.
///
/// The orphan goes first when there is one, and the order is the whole
/// point: the surviving process is recorded ON this session's registry
/// row, and `KillSession` deletes that row -- so killing the session
/// first would leave a live process with nothing left that knows how to
/// end it. A refusing orphan (one that ignores SIGTERM) therefore stops
/// the whole action rather than being stepped over, because carrying on
/// would erase the only handle the human has on it.
export async function endSession(row: SessionRow): Promise<boolean> {
  if (!(await askConfirm(killConfirm(row)))) return false;
  return runKill(row, true);
}

/// Ends every row in the list, after asking once.
export function endAllSessions(rows: SessionRow[]): Promise<number> {
  return endBatch(rows, "all");
}

/// Ends the stale rows -- orphaned, exited, interrupted -- and nothing
/// else, after asking once. The filter lives here rather than in the
/// panel so the prompt and the kills can never disagree about which
/// rows "stale" meant.
export function endStaleSessions(rows: SessionRow[]): Promise<number> {
  return endBatch(
    rows.filter((r) => r.stale),
    "stale"
  );
}

/// Ends the idle rows -- agent neither working nor waiting, and not
/// stale -- after asking once. Filter and prompt share `idleSessions` /
/// `"idle"` so the button's count and what actually ends cannot drift.
export function endIdleSessions(rows: SessionRow[]): Promise<number> {
  return endBatch(idleSessions(rows), "idle");
}

/// Ends the rows the human picked, after asking once with their names.
export function endSelectedSessions(rows: SessionRow[]): Promise<number> {
  return endBatch(rows, "selected");
}

/// Restarts gavin-daemon, after asking.
///
/// The heaviest thing this panel can do, and the reason it belongs here
/// rather than only in Settings: the human who has just read a list of
/// wedged sessions is the one who wants it, and the list they are
/// looking at IS what the restart costs. So the prompt is built from
/// those very rows.
///
/// `restartDaemonInPlace`, not `backend.restartDaemon`: the Rust side
/// rewires the live connections and re-arms the gavin root watches, and
/// the wrapper then re-reads the workspaces the daemon rebuilt on
/// recovery (every surviving session comes back as a bare shell) and
/// refreshes the compat verdict. Calling the command directly would
/// leave the app holding a picture of sessions that no longer exist.
///
/// Returns true when the daemon actually came back, so the caller knows
/// whether to re-read its list. A restart that changed nothing about the
/// version gap says so through an alert -- `restartOutcome` is the same
/// verdict the compat banner and Settings report, and this panel has no
/// banner under the button to render it into.
///
/// `onConfirmed` fires once the human has said yes and before the socket
/// goes away, which is the only moment the panel can act on. It has to
/// stop polling for the duration -- a poll that lands mid-restart reads
/// as "couldn't read the session list" -- and it must not start saying
/// "Restarting…" while a dialog is still asking whether to. Those two
/// are the same instant, and this is it.
export async function restartDaemon(
  rows: SessionRow[],
  compat: DaemonCompat | null,
  onConfirmed?: () => void
): Promise<boolean> {
  const token = await confirmDestructive(
    "restart_daemon",
    [DAEMON_SUBJECT],
    restartConfirm(rows, compat)
  );
  if (token === null) return false;
  onConfirmed?.();
  const before = compat?.daemonVersion ?? null;
  let note: string | null;
  try {
    note = restartOutcome(before, await restartDaemonInPlace(token));
  } catch (e) {
    await showAlert(restartFailedAlert(e));
    return false;
  }
  if (note) await showAlert(restartOutcomeAlert(note));
  return true;
}

/// One confirmation for the batch, matching how every other batch close
/// in the app behaves: a prompt per session would train the human to
/// click through prompts, which is worse than the single honest one that
/// names the count.
///
/// Sequential rather than concurrent. Each kill is a daemon round trip
/// that deletes a registry row, and an orphan that refuses SIGTERM holds
/// its session for up to the daemon's grace period -- doing these in
/// parallel would interleave those waits with unrelated deletions for no
/// gain on a list this size.
async function endBatch(rows: SessionRow[], scope: KillScope): Promise<number> {
  const prompt = killBatchConfirm(rows, scope);
  if (!prompt) return 0;
  if (!(await askConfirm(prompt))) return 0;

  let ended = 0;
  const survived: string[] = [];
  for (const row of rows) {
    // Failures are collected, never thrown: one refusing orphan must not
    // leave the other twenty sessions running.
    if (await runKill(row, false)) ended += 1;
    else survived.push(row.label);
  }
  if (survived.length > 0) await showAlert(survivorsAlert(survived, rows.length));
  return ended;
}

/// The kill itself, with no confirmation of its own.
///
/// `announce` is false in the batch, which reports once at the end rather
/// than putting a modal between every pair of sessions.
async function runKill(row: SessionRow, announce: boolean): Promise<boolean> {
  const plan = killPlan(row);
  if (plan.endOrphan) {
    let result: { ended: boolean; stillRunning: boolean };
    try {
      result = await backend.endOrphan(row.id);
    } catch (e) {
      if (announce) await showAlert(killFailedAlert(row, e));
      return false;
    }
    if (result.stillRunning) {
      if (announce) await showAlert(refusedOrphanAlert(row));
      return false;
    }
    handleOrphanEnded(row.id);
  }
  try {
    await backend.killSession(row.id);
  } catch (e) {
    if (announce) await showAlert(killFailedAlert(row, e));
    return false;
  }
  // The daemon's own `session-exited` push does this too, but only for a
  // session it was hosting -- a row it had already marked exited produces
  // no push, and its tab would sit there dead until the next reload.
  // force: a retained tool-run tab was kept on purpose after its PTY
  // died; ending it from here is the human dismissing that scrollback.
  handleSessionExited(row.id, { force: true });
  return true;
}
