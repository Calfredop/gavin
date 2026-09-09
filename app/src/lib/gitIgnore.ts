// Turning a path into an ignore rule: pure pattern math shared by the Git
// tab's untracked-row menu (GitChanges.svelte) and the Files tab's tree
// menu (fileTreeMenu.ts) -- what to offer never depends on which tree is
// asking, only on the path and whether it names a folder. The two files
// gavin can add a rule to (git/ignore.rs resolves both through git
// itself, never by joining `cwd` onto a hard-coded name).

export type IgnoreKind = "gitignore" | "exclude";

export const IGNORE_KIND_LABEL: Record<IgnoreKind, string> = {
  gitignore: ".gitignore",
  exclude: ".git/info/exclude",
};

/// Anchored to the file the pattern's own .gitignore/exclude sits at
/// (the repository's toplevel) -- unanchored, "build" would also
/// swallow a different file or folder named `build` three directories
/// over.
export function ignoreFilePattern(path: string): string {
  return `/${path}`;
}

/// Trailing slash: a directory-only rule, the same convention
/// git/tracking.rs's own `.gavin/`/`.gavin-root/` patterns use, so a
/// stray FILE later named the same as the folder is not swept up by it.
export function ignoreFolderPattern(path: string): string {
  return `/${path}/`;
}

/// The extension off a file's name, or null when it has none worth a
/// rule of its own. A dotfile's leading dot does not count -- `.env`
/// has no extension by this reckoning, only a name -- and neither does
/// a bare trailing dot.
export function fileExtension(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  return ext.length > 0 ? ext : null;
}

/// Unanchored, on purpose: "ignore every *.log file" means everywhere
/// in the tree, not just this one's own directory.
export function ignoreExtensionPattern(path: string): string | null {
  const ext = fileExtension(path);
  return ext ? `*.${ext}` : null;
}

export interface IgnoreMenuEntry {
  label: string;
  onPick: () => void;
}

/// The ignore actions for one root-relative path: file or folder, into
/// `.gitignore` or (checkout-local) `.git/info/exclude`. `onPick` fires
/// with the kind and the exact pattern to append -- the caller owns the
/// write (dedup, refresh, error reporting), this only says WHAT.
export function ignoreMenuItems(
  path: string,
  isDir: boolean,
  onPick: (kind: IgnoreKind, pattern: string) => void
): IgnoreMenuEntry[] {
  const noun = isDir ? "folder" : "file";
  const pattern = isDir ? ignoreFolderPattern(path) : ignoreFilePattern(path);
  const items: IgnoreMenuEntry[] = [{ label: `Ignore this ${noun}`, onPick: () => onPick("gitignore", pattern) }];
  if (!isDir) {
    const ext = ignoreExtensionPattern(path);
    if (ext) items.push({ label: `Ignore all ${ext} files`, onPick: () => onPick("gitignore", ext) });
  }
  items.push({
    label: `Ignore this ${noun} (this checkout only)`,
    onPick: () => onPick("exclude", pattern),
  });
  return items;
}
