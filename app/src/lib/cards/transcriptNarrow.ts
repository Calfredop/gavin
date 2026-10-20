// Cut a checkout-wide run diff down to the files the run's own agent
// touched, using the same transcript reader and shell-write records the
// Review tab already uses. Shared so the session Changes view and Review
// cannot drift on what "this agent's files" means.
//
// The checkout's files are the candidates and the transcript only picks
// among them: a file the agent wrote and somebody since reverted is not
// a change of this run any more, and the diff under each row has to
// exist. What counts as "touched" -- an edit tool, a shell command that
// named the file, or what the shell-write hook saw a command change --
// and what slips past it is `agent_edits.rs`'s.

import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import type { RunChanges } from "$lib/git/git";
import { daemonCompat } from "$lib/core/layoutState";
import { featureBlockedReason } from "$lib/core/daemonCompat";

/// What the narrow needs of a run. Deliberately smaller than Review's
/// `TouchRequest`: peers and the card path are unrelated to which files
/// the transcript names.
export interface TranscriptNarrowRequest {
  cwd: string;
  conversationId?: string | null;
}

/// The checkout's changes cut down to the files the run's agent touched,
/// or null when the transcript has no answer -- no conversation id, a
/// transcript gone or unreadable, a host too old to ask -- and the
/// checkout's own answer has to stand.
export async function narrowToTranscript(
  workspaceId: string,
  request: TranscriptNarrowRequest,
  changes: RunChanges
): Promise<RunChanges | null> {
  if (!request.conversationId || !changes.root) return null;
  // A rename is the run's when either end of it is: an agent that moved
  // a file may have named only the path it moved it from.
  const candidates = changes.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
  const observed = await shellWritesFor(workspaceId, request.conversationId);
  let report: backend.TouchReport;
  try {
    report = await backend.cardRunTouchedFiles(
      request.conversationId,
      request.cwd,
      changes.root,
      candidates,
      observed
    );
  } catch {
    return null;
  }
  if (report.kind !== "ready") return null;
  const touched = new Set(report.paths);
  return {
    ...changes,
    files: changes.files.filter((f) => touched.has(f.path) || (f.oldPath != null && touched.has(f.oldPath))),
  };
}

/// What the shell-write hook recorded of a run's shell calls, or null:
/// a daemon older than v72 kept none and is not asked
/// (`FEATURE_MIN_VERSION.shellWrites`), and a read that failed is the same
/// answer. Null judges every command by its text -- the reading every run
/// had before the hook, and still the one for a run it never watched.
export async function shellWritesFor(
  workspaceId: string,
  conversationId: string
): Promise<backend.ShellWrites | null> {
  if (featureBlockedReason(get(daemonCompat), "shellWrites")) return null;
  try {
    return (await backend.shellWrites(workspaceId, conversationId)) ?? null;
  } catch {
    return null;
  }
}
