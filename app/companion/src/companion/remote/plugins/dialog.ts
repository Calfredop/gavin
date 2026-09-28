// The remote shim for `@tauri-apps/plugin-dialog`.
//
// The one OS dialog the desktop still uses is its file picker, and on a
// Workstation it would open on the desk, in front of nobody. Choosing a
// folder from a Device is a surface of its own -- a browser over the
// Workstation's folders, starting at home (spec "Workspace state split")
// -- so until a caller is given that, it is told what a picker says when
// the human closes it: nothing was chosen.
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  multiple?: boolean;
  recursive?: boolean;
  canCreateDirectories?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/// Typed as the plugin's own `open` is -- a path, several, or nothing --
/// because the desktop's callers and their suites are written against
/// that; the answer itself is always "nothing".
export async function open(_options?: OpenDialogOptions): Promise<string | string[] | null> {
  return null;
}
