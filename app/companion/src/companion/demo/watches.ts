// What the Demo Workstation tells a watcher, and when.
//
// A desk reports a change only to something that asked: `file-changed`
// for a file an editor watches (`watch_file_for_viewer`), and
// `git-changed` for a checkout the Git tab watches (`git_watch`), with
// the cwd that was watched as its payload. The one it reports unasked is
// `gavin-tree-changed`: the daemon watches every workspace's cards. Every
// write in the demo -- a card command's, the editor's, or git's own when
// a checkout or a merge rewrites the working tree -- goes through here,
// so the bundle hears exactly what it would hear from a desk.
import type { DemoContext } from "$companion/demo/answer";
import { rescan } from "$companion/demo/cardFiles";
import { contains, type DemoRepo } from "$companion/demo/repo";

export type WatchKind = "files" | "git";

export function watch(demo: DemoContext, kind: WatchKind, key: string): void {
  const table = demo.state.watches[kind];
  table[key] = (table[key] ?? 0) + 1;
}

/// Releases one watch. Releasing what is not watched is not an error,
/// as on the desk.
export function unwatch(demo: DemoContext, kind: WatchKind, key: string): void {
  const table = demo.state.watches[kind];
  if (!table[key]) return;
  table[key] -= 1;
  if (table[key] === 0) delete table[key];
}

/// The repository a path belongs to, or null.
export function repoHolding(demo: DemoContext, path: string): DemoRepo | null {
  return Object.values(demo.state.repos).find((repo) => contains(repo, path)) ?? null;
}

/// `git-changed` for every watched checkout of `repo`.
export function announceRepo(demo: DemoContext, repo: DemoRepo): void {
  for (const cwd of Object.keys(demo.state.watches.git)) {
    if (contains(repo, cwd)) demo.emit("git-changed", { cwd });
  }
}

/// `gavin-tree-changed` for every workspace whose cards now read
/// differently, then `file-changed` for every watched file whose content
/// is not what it was in `before` (a snapshot of the demo's files).
export function announceFiles(demo: DemoContext, before: Record<string, string>): void {
  for (const [workspaceId, tree] of Object.entries(demo.state.trees)) {
    const next = rescan(tree, demo.state.files);
    if (JSON.stringify(next) === JSON.stringify(tree)) continue;
    demo.state.trees[workspaceId] = next;
    demo.emit("gavin-tree-changed", [workspaceId, next]);
  }
  for (const path of Object.keys(demo.state.watches.files)) {
    if (before[path] !== demo.state.files[path]) demo.emit("file-changed", path);
  }
}
