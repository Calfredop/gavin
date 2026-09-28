// The remote shim for `@tauri-apps/plugin-opener`.
//
// On the desk `openUrl` hands a link to the OS. On a Device it is one of
// the channel's own messages: the shell opens the link in the system
// browser, and nothing else in the bundle ever navigates (ADR 0005).
// Without this the plugin's own JS would run instead, and ask the DESK
// to open a browser nobody is sitting at.
import { channel, NOT_CONNECTED } from "$companion/remote/connection";

export async function openUrl(url: string | URL): Promise<void> {
  const client = channel();
  if (!client) throw NOT_CONNECTED;
  const link = String(url);
  // Rejecting rather than resolving quietly: the desktop's callers
  // already handle a link that would not open, and a tap that silently
  // does nothing is the worse failure.
  if (!(await client.openExternal(link))) throw `this Companion cannot open ${link}`;
}
