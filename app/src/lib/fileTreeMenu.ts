// Right-click menu contents for the Files tab's tree rows. Pure
// builders, the same shape planTreeMenu.ts has for the Plans tree, so
// the choices -- what appears, in what order, and what is refused --
// are testable without mounting a component.

import type { FileNode } from "$lib/fileTree";

export interface FileTreeMenuItem {
  label: string;
  danger?: boolean;
  /// Shown but inert; the shared ContextMenu renders it greyed. Used
  /// where hiding the row would read as "gavin cannot do this at all".
  disabled?: boolean;
  onPick: () => void;
}

export interface FileTreeMenuCallbacks {
  /// A file: into the editor pane, or -- for a type gavin's viewer does
  /// not handle -- the OS's default application. The row's own click
  /// does the same thing, so the entry is the discoverable form of it.
  onOpen: (node: FileNode) => void;
  /// Null when there is no terminal session to anchor a split to. The
  /// entry is then omitted rather than shown dead, matching the Plans
  /// tree's "Open beside terminal".
  onOpenInTab: ((node: FileNode) => void) | null;
  onCopyPath: (node: FileNode) => void;
  onRevealInFinder: (node: FileNode) => void;
  onNewFile: (dir: FileNode) => void;
  onNewFolder: (dir: FileNode) => void;
  onRename: (node: FileNode) => void;
  onTrash: (node: FileNode) => void;
  /// Re-reads one directory. The tree has no watcher on the repo -- see
  /// fileTree.ts -- so this is how a folder changed by an agent or a
  /// terminal catches up.
  onRefresh: (dir: FileNode) => void;
}

export interface RowMenuContext {
  /// The workspace root's own row. It has no rename and no trash: the
  /// host refuses both, and offering an entry that can only fail is
  /// worse than not offering it.
  isRoot: boolean;
  /// Whether gavin's own viewer handles this extension
  /// (`viewable_extensions`). False sends the row to the OS's default
  /// application, which is the PRD's standing rule for binaries and
  /// media -- and means there is no in-app tab to open it in either.
  viewable: boolean;
}

/// The label for opening a file, which says where it will open. A
/// screenshot and a `.rs` file both open on a click; only one of them
/// opens here, and the human should not have to find that out by
/// clicking.
export function openLabel(viewable: boolean): string {
  return viewable ? "Open" : "Open in the default app";
}

export function fileMenuItems(
  node: FileNode,
  ctx: RowMenuContext,
  cb: FileTreeMenuCallbacks
): FileTreeMenuItem[] {
  const items: FileTreeMenuItem[] = [
    { label: openLabel(ctx.viewable), onPick: () => cb.onOpen(node) },
  ];
  // A tab hosts gavin's editor, so a file the editor cannot render has
  // nothing to open in one.
  if (ctx.viewable && cb.onOpenInTab) {
    const openInTab = cb.onOpenInTab;
    items.push({ label: "Open in a tab", onPick: () => openInTab(node) });
  }
  items.push(
    { label: "Copy path", onPick: () => cb.onCopyPath(node) },
    { label: "Reveal in Finder", onPick: () => cb.onRevealInFinder(node) },
    { label: "Rename…", onPick: () => cb.onRename(node) },
    { label: "Move to Trash", danger: true, onPick: () => cb.onTrash(node) }
  );
  return items;
}

export function directoryMenuItems(
  node: FileNode,
  ctx: RowMenuContext,
  cb: FileTreeMenuCallbacks
): FileTreeMenuItem[] {
  const items: FileTreeMenuItem[] = [
    { label: "New file…", onPick: () => cb.onNewFile(node) },
    { label: "New folder…", onPick: () => cb.onNewFolder(node) },
    { label: "Refresh", onPick: () => cb.onRefresh(node) },
    { label: "Copy path", onPick: () => cb.onCopyPath(node) },
    { label: "Reveal in Finder", onPick: () => cb.onRevealInFinder(node) },
  ];
  if (!ctx.isRoot) {
    items.push(
      { label: "Rename…", onPick: () => cb.onRename(node) },
      { label: "Move to Trash", danger: true, onPick: () => cb.onTrash(node) }
    );
  }
  return items;
}

/// The one entry point a row's `oncontextmenu` needs.
export function rowMenuItems(
  node: FileNode,
  ctx: RowMenuContext,
  cb: FileTreeMenuCallbacks
): FileTreeMenuItem[] {
  return node.isDir ? directoryMenuItems(node, ctx, cb) : fileMenuItems(node, ctx, cb);
}

/// What the Trash prompt says. A whole directory is a different promise
/// from one file, so it says which, and both say where the entry goes --
/// the Trash, recoverable, never an `rm`.
export function trashPromptLines(node: FileNode): string[] {
  return [
    node.isDir
      ? `Moves the ${node.name} folder and everything in it to the Trash.`
      : `Moves ${node.name} to the Trash.`,
    "You can put it back from Finder.",
  ];
}
