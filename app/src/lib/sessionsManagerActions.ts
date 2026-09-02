// Doing what the task manager offers: jumping to a session, ending one,
// ending all of them.
//
// The write side of sessionsManager.ts, kept out of that module so the
// arithmetic and the wording stay a pure, testable projection. Every
// destructive path here goes through a confirmation built there, so the
// panel cannot ask more softly than the text those tests pin down.
//
// `confirm`/`message` come from @tauri-apps/plugin-dialog, matching
// orphanActions.ts and every other action module in this tree. They
// convert with the rest when a shared in-app modal lands.

import { confirm, message } from "@tauri-apps/plugin-dialog";
import { get } from "svelte/store";
import * as backend from "./backend";
import {
  handleAgentSessionSpawned,
  handleOrphanEnded,
  handleSessionExited,
  layoutState,
  switchToSessionInPage,
  switchWorkspaceView,
} from "./layoutState";
import { findSessionLocation } from "./workspace";
import { killAllConfirm, killConfirm, killPlan, type SessionRow } from "./sessionsManager";

/// Put the human in front of a session, giving it a tab first if nothing
/// is showing it.
///
/// The hidden case is the reason this exists. A git-commit run, an
/// orchestration Generate, a session left behind by a closed page: they
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
  if (!(await confirm(killConfirm(row), { title: "gavin", kind: "warning" }))) return false;
  return runKill(row, true);
}

/// Ends every row in the list, after asking once.
///
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
export async function endAllSessions(rows: SessionRow[]): Promise<number> {
  const prompt = killAllConfirm(rows);
  if (!prompt) return 0;
  if (!(await confirm(prompt, { title: "gavin", kind: "warning" }))) return 0;

  let ended = 0;
  const survived: string[] = [];
  for (const row of rows) {
    // Failures are collected, never thrown: one refusing orphan must not
    // leave the other twenty sessions running.
    if (await runKill(row, false)) ended += 1;
    else survived.push(row.label);
  }
  if (survived.length > 0) {
    await message(
      `${survived.length} of ${rows.length} could not be ended: ${survived.join(", ")}. ` +
        `A process that ignores SIGTERM is the usual reason — those are still listed, ` +
        `with the pid to end from Activity Monitor.`,
      { title: "gavin", kind: "warning" }
    );
  }
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
      if (announce) await message(`Couldn't end ${row.label}: ${e}`, { title: "gavin", kind: "error" });
      return false;
    }
    if (result.stillRunning) {
      if (announce) {
        await message(
          `${row.label} was asked to stop and is still running — it is ignoring SIGTERM, ` +
            `which is how it survived the daemon in the first place. The session is left in ` +
            `place so you keep the pid; end it from Activity Monitor, or with ` +
            `\`kill -9 ${row.orphan?.pid}\`.`,
          { title: "gavin", kind: "warning" }
        );
      }
      return false;
    }
    handleOrphanEnded(row.id);
  }
  try {
    await backend.killSession(row.id);
  } catch (e) {
    if (announce) await message(`Couldn't end ${row.label}: ${e}`, { title: "gavin", kind: "error" });
    return false;
  }
  // The daemon's own `session-exited` push does this too, but only for a
  // session it was hosting -- a row it had already marked exited produces
  // no push, and its tab would sit there dead until the next reload.
  handleSessionExited(row.id);
  return true;
}
