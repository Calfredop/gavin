// Right-click menu contents for the plan explorer's three row types.
// Pure builders so the choices (order, labels, when Delete appears) are
// testable without mounting the tree.

import type { ExplorerContextNode, ExplorerFile, ExplorerGroup } from "./planExplorer";

export interface TreeMenuItem {
  label: string;
  danger?: boolean;
  onPick: () => void;
}

export interface TreeMenuCallbacks {
  onSelect: (path: string) => void;
  // Null when there is no terminal session to anchor a split to -- the
  // entry is omitted rather than disabled, like the row's split button.
  onOpenInSplit: ((path: string) => void) | null;
  onDeleteFile: (file: ExplorerFile) => void;
  onCompose: (folderPath: string, group: ExplorerGroup) => void;
  onRemoveOutside: (context: ExplorerContextNode) => void;
  // Opens a folder in Finder: the context's own folder, or one of its
  // plans/docs/specs sub-folders inside .gavin*/.
  onShowInFinder: (folderPath: string) => void;
}

const NEW_LABELS: Record<ExplorerGroup, string> = {
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
  items.push({ label: "Delete…", danger: true, onPick: () => cb.onDeleteFile(file) });
  return items;
}

export function contextRowMenuItems(
  context: ExplorerContextNode,
  cb: TreeMenuCallbacks
): TreeMenuItem[] {
  const items: TreeMenuItem[] = (["plans", "docs", "specs"] as const).map((group) => ({
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
  return [
    { label: NEW_LABELS[group], onPick: () => cb.onCompose(context.folderPath, group) },
    { label: "Show in Finder", onPick: () => cb.onShowInFinder(`${context.gavinDir}/${group}`) },
  ];
}
