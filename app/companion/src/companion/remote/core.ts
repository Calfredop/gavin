// The remote shim for `@tauri-apps/api/core` (ADR 0003).
//
// This project's build resolves that module name HERE, so the desktop's
// `backend.ts` -- and every module that calls `invoke` directly -- runs
// unchanged with its commands travelling the channel to the Workstation,
// where they run as the same Tauri commands the desktop's own webview
// would have reached.
import { channel, NOT_CONNECTED } from "$companion/remote/connection";
import { refusedOnDevice } from "$companion/remote/remoteRole";

export type InvokeArgs = Record<string, unknown>;

/// What a caller sees when a command fails: the Workstation's words as a
/// plain string, which is what a Tauri command's `Err(String)` rejects
/// with. The desktop's callers render `String(e)`, and an Error object
/// there would put "Error: " in front of every message on screen.
function asTauriRejects(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  // Before the channel, so "never sent" is a property of the wire and
  // not of every surface remembering (see remoteRole.ts).
  const refusal = refusedOnDevice(cmd);
  if (refusal) throw refusal;
  const client = channel();
  if (!client) throw NOT_CONNECTED;
  try {
    return await client.invoke<T>(cmd, args ?? {});
  } catch (e) {
    throw asTauriRejects(e);
  }
}
