import { open } from "@tauri-apps/plugin-dialog";
import { toPosixPath } from "./paths";

// The one place `@tauri-apps/plugin-dialog`'s file picker is called.
//
// Two reasons it is not called directly any more. The picker hands back
// the OS's own spelling of a path, which on Windows means backslashes --
// and everything downstream (card ids, worktree roots, the file tree,
// `[worktree] setup` cwds) is compared and split as a forward-slash
// path, normalised at the daemon and host boundaries by
// `protocol::wire_path`. A picked path never crosses either of those, so
// it is the one route by which a backslash reaches the UI, and this is
// where it stops.
//
// The second reason is the narrow type: `open` returns `string`,
// `string[]` or `null` depending on options that are decided at the call
// site, and every caller here wants exactly one path or none.
export type PickOptions = {
  directory?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
};

export async function pickPath(options: PickOptions): Promise<string | null> {
  const picked = await open({ ...options, multiple: false });
  return typeof picked === "string" ? toPosixPath(picked) : null;
}
