// The two things the Updates panel can DO, kept out of the template so
// the confirmation and the token are testable without mounting anything.
//
// `installUpdate` is the only route to the host's gated command, and the
// only place that mints its token. It counts the live sessions first --
// not to refuse, but because the prompt has to say what installing
// actually leaves behind (`updates.ts`'s `installPrompt`).

import * as backend from "$lib/backend";
import { grantForAnsweredPrompt } from "$lib/confirmGate";
import { installPrompt, liveSessions, type AvailableUpdate, type UpdatePrompt } from "$lib/shell/updates";

/// The prompt to draw before installing, with the live-session count
/// already resolved.
///
/// A daemon that cannot be reached counts as zero rather than failing:
/// the human is trying to install an update, and refusing to describe it
/// because the session list is unavailable would block the action over a
/// sentence. The prompt still names the daemon consequence either way.
export async function installConfirmPrompt(update: AvailableUpdate): Promise<UpdatePrompt> {
  let live = 0;
  try {
    const sample = await backend.listManagedSessions();
    live = liveSessions(sample.sessions).length;
  } catch {
    live = 0;
  }
  return installPrompt(update, live);
}

/// Mints the token for a prompt that has just been answered yes, and
/// sends the install.
///
/// The token's subject is the VERSION, so this cannot be called for a
/// different release than the one the human read. On success it does not
/// return -- the app is replaced and relaunched -- so a resolved promise
/// here means a platform or a failure mode that came back, and the
/// caller reports it the same way it reports a rejection.
export async function runInstall(update: AvailableUpdate): Promise<void> {
  const token = await grantForAnsweredPrompt("install_update", [update.version]);
  await backend.installUpdate(update.version, token);
}

/// Saves the endpoint override (or clears it) and returns the channel as
/// the host now reports it, so the panel redraws from one answer rather
/// than from what it hoped the write did.
export async function saveEndpoint(endpoint: string | null): Promise<void> {
  await backend.setUpdateEndpoint(endpoint);
}
