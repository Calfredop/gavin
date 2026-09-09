// Copy for the discard confirmations (spec §4): the dialog names exactly
// what goes, and untracked files get their own sentence because `git
// clean` deletes them from disk.

import type { FileEntry } from "$lib/git/git";

const MAX_LISTED = 8;

export interface FileDiscardPrompt {
  title: string;
  body: string;
  tracked: string[];
  untracked: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED);
  const rest = paths.length - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n… and ${rest} more` : "");
}

export function describeFileDiscard(entries: FileEntry[]): FileDiscardPrompt {
  const tracked = entries.filter((e) => e.status !== "?").map((e) => e.path);
  const untracked = entries.filter((e) => e.status === "?").map((e) => e.path);
  let title: string;
  if (tracked.length && untracked.length) {
    title = `Discard changes in ${plural(tracked.length, "file")} and delete ${plural(untracked.length, "untracked file")}?`;
  } else if (untracked.length) {
    title = `Delete ${plural(untracked.length, "untracked file")}?`;
  } else {
    title = `Discard changes in ${plural(tracked.length, "file")}?`;
  }
  const body = `${listPaths([...tracked, ...untracked])}\n\nThis cannot be undone.`;
  return { title, body, tracked, untracked };
}

export function describeHunkDiscard(path: string, selectedCount: number | null): { title: string; body: string } {
  const title = selectedCount === null ? `Discard this hunk in ${path}?` : `Discard ${plural(selectedCount, "selected line")}?`;
  return { title, body: `${path}\n\nThe working-tree changes are reverted. This cannot be undone.` };
}
