// Adding a workspace from a phone: a folder browser over the file viewer's
// directory listing (`list_directory`), starting at the home folder of
// whoever runs the desk (ADR 0006).
//
// The desk picks a folder with the OS's own dialog (`workspaceOpen.ts`),
// which a phone has no way to open on the desk's disk. This walks that disk
// a folder at a time instead, through the listing the Files surface reads,
// and ends where the desk's "Open workspace…" ends: a workspace on the
// folder, named for it (`nameForRoot`), gavin set up in it if the human
// says so -- and, for a folder a workspace already works in, that workspace
// opened rather than a second one made.
import type { FileNode } from "$lib/files/fileTree";
import { sameRoot, type Workspace } from "$lib/core/workspace";
import { nameForRoot } from "$lib/workspace/workspaceOpen";

/// The top of the disk the home folder is on: what the browser lists
/// against, so it can go up past the home folder -- a project can live on
/// another volume, or beside the home folder rather than in it. The host
/// sends paths with forward slashes on every platform (`wire_path`).
export function browseRoot(home: string): string {
  const drive = /^[A-Za-z]:\//.exec(home);
  return drive ? drive[0] : "/";
}

/// The workspace already working in `folder`, if one is.
export function workspaceAt(workspaces: Workspace[], folder: string): Workspace | null {
  return workspaces.find((w) => w.rootPath && !w.ssh?.host && sameRoot(w.rootPath, folder)) ?? null;
}

export interface BrowserRow {
  path: string;
  name: string;
  isDir: boolean;
  symlink: boolean;
  /// The workspace this folder already is, by name.
  workspace: string | null;
}

export interface BrowserListing {
  rows: BrowserRow[];
  /// Entries left out because their names start with a dot.
  hidden: number;
}

/// One folder's entries as the browser draws them. Hidden entries are left
/// out, as the desk's own folder dialog leaves them out: a home folder is
/// dozens of them, and a project is not usually one. Files stay, in the
/// tree's order, so the folder a project is in can be told by what is in
/// it; only a folder is somewhere to go.
export function browserListing(nodes: FileNode[], workspaces: Workspace[]): BrowserListing {
  const shown = nodes.filter((node) => !node.name.startsWith("."));
  return {
    rows: shown.map((node) => ({
      path: node.path,
      name: node.name,
      isDir: node.isDir,
      symlink: node.symlink,
      workspace: node.isDir ? (workspaceAt(workspaces, node.path)?.name ?? null) : null,
    })),
    hidden: nodes.length - shown.length,
  };
}

export function hiddenNote(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `${hidden} hidden ${hidden === 1 ? "item" : "items"} not shown.`;
}

/// What the button under the browser does for the folder on screen: open
/// the workspace that is already there, or add one named for the folder.
/// The top of the disk is not a folder to work in.
export type FolderAction =
  | { kind: "open"; workspaceId: string; label: string }
  | { kind: "add"; name: string; label: string }
  | { kind: "none" };

export function folderAction(folder: string, root: string, workspaces: Workspace[]): FolderAction {
  if (!folder || folder === root) return { kind: "none" };
  const already = workspaceAt(workspaces, folder);
  if (already) return { kind: "open", workspaceId: already.id, label: `Open ${already.name}` };
  const name = nameForRoot(folder);
  return { kind: "add", name, label: `Add ${name}` };
}
