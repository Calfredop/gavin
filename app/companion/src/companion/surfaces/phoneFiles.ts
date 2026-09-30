// A workspace's files, as a phone draws them: one folder at a time, and a
// file opened over it.
//
// The desk draws a tree beside an editor. A phone has room for one of the
// two, so it walks the same tree a folder at a time -- the desk's own tree
// state (`fileTree.ts`) holds what has been read, so going back up is
// instant and a folder read once is not read again until asked -- and
// opens a file in the desk's own editor.
import {
  baseName,
  isUnder,
  joinPath,
  type FileNode,
  type FileTreeState,
} from "$lib/files/fileTree";
import { isViewableExtension } from "$lib/files/fileTypes";
import type { FilesPlace } from "$companion/state/viewState";

function atOrUnder(root: string, path: string): boolean {
  return path === root || isUnder(root, path);
}

/// Where the surface opens: where it was, when that is still inside this
/// workspace's root, and the root otherwise. A root the workspace has
/// been moved off is not somewhere to return to.
export function startingPlace(root: string, remembered: FilesPlace | undefined): FilesPlace {
  if (!remembered || !atOrUnder(root, remembered.dir)) return { dir: root, file: null };
  const file = remembered.file !== null && isUnder(remembered.dir, remembered.file) ? remembered.file : null;
  return { dir: remembered.dir, file };
}

export interface Crumb {
  path: string;
  name: string;
}

/// The folders from the root down to `dir`, each a place to jump back
/// to. The root is named for its folder, as the desk's tree names it.
export function crumbs(root: string, dir: string): Crumb[] {
  const out: Crumb[] = [{ path: root, name: baseName(root) || root }];
  if (!isUnder(root, dir)) return out;
  let current = root;
  for (const part of dir.slice(root.length).split("/").filter(Boolean)) {
    current = joinPath(current, part);
    out.push({ path: current, name: part });
  }
  return out;
}

/// The folder above `dir`, or null at the root: the tree never leaves it.
export function folderAbove(root: string, dir: string): string | null {
  const trail = crumbs(root, dir);
  return trail.length > 1 ? trail[trail.length - 2].path : null;
}

export type FolderView =
  | { kind: "unread" }
  | { kind: "failed"; message: string }
  | { kind: "listed"; nodes: FileNode[]; omitted: number };

/// One folder of the tree as it stands: not read yet, failed, or listed.
/// "Not read" and "empty" are never the same answer, as on the desk.
export function folderView(tree: FileTreeState, dir: string): FolderView {
  const error = tree.errors[dir];
  if (error !== undefined) return { kind: "failed", message: error };
  const nodes = tree.children[dir];
  if (nodes === undefined) return { kind: "unread" };
  return { kind: "listed", nodes, omitted: tree.omitted[dir] ?? 0 };
}

/// The note under a folder the host listed only in part. The desk's
/// version points at Finder, which is at the desk.
export function omittedNote(omitted: number): string | null {
  if (omitted <= 0) return null;
  const count = omitted.toLocaleString("en-US");
  return `${count} more ${omitted === 1 ? "entry" : "entries"} not listed: this folder is too big to show whole.`;
}

/// What a tap on a row does: walk into a folder, open a file in the
/// editor, or -- for what the desk hands to another application, a
/// picture, a binary -- say that the phone cannot show it.
export function tapOn(node: FileNode, viewable: string[]): "enter" | "open" | "unviewable" {
  if (node.isDir) return "enter";
  return isViewableExtension(node.path, viewable) ? "open" : "unviewable";
}

export function unviewableNote(node: FileNode): string {
  return `${node.name} can't be shown here. Gavin opens files like it in their own application, at the desk.`;
}

/// Whether a remembered file is still in its folder, once the folder is
/// listed. Unknown -- the folder not read yet -- counts as there: the
/// editor says so itself if it is not.
export function stillListed(tree: FileTreeState, place: FilesPlace): boolean {
  if (place.file === null) return true;
  const view = folderView(tree, place.dir);
  if (view.kind !== "listed") return true;
  return view.nodes.some((node) => node.path === place.file);
}
