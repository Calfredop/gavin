// Right-click menu contents for the plan explorer's three row types.
// Pure builders so the choices (order, labels, when Delete appears) are
// testable without mounting the tree.

import { CREATABLE_GROUPS, groupFolder } from "./planExplorer";
import type { CreatableGroup, ExplorerContextNode, ExplorerFile, ExplorerGroup } from "./planExplorer";

export interface TreeMenuItem {
  label: string;
  danger?: boolean;
  // Shown but inert -- the shared ContextMenu renders it greyed. Used
  // for an action the running daemon is too old to serve, where hiding
  // the row would read as "this app cannot do that at all".
  disabled?: boolean;
  onPick: () => void;
}

export interface TreeMenuCallbacks {
  onSelect: (path: string) => void;
  // Null when there is no terminal session to anchor a split to -- the
  // entry is omitted rather than disabled, like the row's split button.
  onOpenInSplit: ((path: string) => void) | null;
  onDeleteFile: (file: ExplorerFile) => void;
  // Archive group only: files the card back on the board by its status.
  // Null on a surface that cannot restore at all -- the entry is then
  // omitted rather than shown dead.
  onRestoreFile: ((file: ExplorerFile) => void) | null;
  // Non-null when the running daemon is too old to serve the archive;
  // the restore entry then shows disabled, carrying the reason.
  restoreBlocked: string | null;
  onCompose: (folderPath: string, group: CreatableGroup) => void;
  onRemoveOutside: (context: ExplorerContextNode) => void;
  // Opens a folder in Finder: the context's own folder, or one of its
  // plans/docs/specs sub-folders inside .gavin*/.
  onShowInFinder: (folderPath: string) => void;
}

const NEW_LABELS: Record<CreatableGroup, string> = {
  plans: "New plan…",
  docs: "New doc…",
  specs: "New spec…",
};

export function fileMenuItems(file: ExplorerFile, cb: TreeMenuCallbacks): TreeMenuItem[] {
  const items: TreeMenuItem[] = [{ label: "Open", onPick: () => cb.onSelect(file.path) }];
  const split = cb.onOpenInSplit;
  if (split) {
    items.push({ label: "Open beside terminal", onPick: () => split(file.path) });
  }
  // The way OUT of the archive, on the surface that is the only place a
  // card in `plans/archive/` can be read without leaving the Plans tab.
  // Archive group only: nothing else is in there to restore, and the
  // entry would be a no-op everywhere else.
  const restore = cb.onRestoreFile;
  if (file.group === "archive" && restore) {
    items.push({
      // No tooltip layer in the menu, so a disabled row says why in its
      // own label -- same shape as the card menu's archive entry.
      label: cb.restoreBlocked ? "Restore from archive — restart the daemon" : "Restore from archive",
      disabled: cb.restoreBlocked !== null,
      onPick: () => restore(file),
    });
  }
  items.push({ label: "Delete…", danger: true, onPick: () => cb.onDeleteFile(file) });
  return items;
}

export function contextRowMenuItems(
  context: ExplorerContextNode,
  cb: TreeMenuCallbacks
): TreeMenuItem[] {
  const items: TreeMenuItem[] = CREATABLE_GROUPS.map((group) => ({
    label: NEW_LABELS[group],
    onPick: () => cb.onCompose(context.folderPath, group),
  }));
  items.push({ label: "Show in Finder", onPick: () => cb.onShowInFinder(context.folderPath) });
  if (context.outside) {
    // Unlisting, not deletion: the folder's files stay on disk.
    items.push({
      label: "Remove from navigator",
      danger: true,
      onPick: () => cb.onRemoveOutside(context),
    });
  }
  return items;
}

export function groupRowMenuItems(
  context: ExplorerContextNode,
  group: ExplorerGroup,
  cb: TreeMenuCallbacks
): TreeMenuItem[] {
  const items: TreeMenuItem[] = [];
  // Nothing is ever authored INTO the archive -- a card gets there by
  // being archived -- so that group's row offers no "New …" entry rather
  // than a dead one.
  if (group !== "archive") {
    items.push({ label: NEW_LABELS[group], onPick: () => cb.onCompose(context.folderPath, group) });
  }
  items.push({
    label: "Show in Finder",
    onPick: () => cb.onShowInFinder(groupFolder(context.gavinDir, group)),
  });
  return items;
}
