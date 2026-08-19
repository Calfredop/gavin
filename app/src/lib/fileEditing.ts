import { writable } from "svelte/store";
import { isMarkdown } from "./fileTypes";

export type EditorMode = "formatted" | "plain" | "edit";

// Markdown has a rendered form; nothing else does.
export function modesFor(path: string): EditorMode[] {
  return isMarkdown(path) ? ["formatted", "plain", "edit"] : ["plain", "edit"];
}

// File tabs are opened by cmd+clicking a path in terminal output -- a
// read-first gesture. The PRD and agent-file hub tabs exist to be
// written, so they open ready to type (D25).
export function defaultMode(path: string, surface: "tab" | "hub"): EditorMode {
  if (surface === "hub") return "edit";
  return isMarkdown(path) ? "formatted" : "plain";
}

// A file that failed to load has no buffer to edit; a truncated one holds
// only a prefix, so writing it back would destroy everything past the
// cap. A file that merely doesn't exist yet IS editable -- saving creates
// it, which is how the agent-file tab bootstraps CLAUDE.md.
export function canEdit(state: { truncated: boolean; error: string | null }): boolean {
  return !state.truncated && state.error === null;
}

export type ExternalChangeVerdict = "ignore" | "reload" | "conflict";

// Content-based, never time-based (D26): our own save trips the watcher,
// and a timing window would be defeated by a slow disk. If what landed on
// disk equals what we already have, there is nothing to do -- that covers
// both our echo and someone writing identical content.
export function resolveExternalChange(input: {
  incoming: string;
  buffer: string;
  dirty: boolean;
}): ExternalChangeVerdict {
  if (input.incoming === input.buffer) return "ignore";
  return input.dirty ? "conflict" : "reload";
}

// Paths with unsaved buffers, so Pane.svelte can show a dot on the tab
// without reaching into the editor component.
export const dirtyPaths = writable<Set<string>>(new Set());

export function setPathDirty(path: string, dirty: boolean): void {
  dirtyPaths.update((current) => {
    if (current.has(path) === dirty) return current;
    const next = new Set(current);
    if (dirty) {
      next.add(path);
    } else {
      next.delete(path);
    }
    return next;
  });
}
