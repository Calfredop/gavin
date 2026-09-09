import { writable } from "svelte/store";
import { isMarkdown } from "$lib/fileTypes";

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

// What a re-read means when the file is no longer on disk. "absent" and
// "deleted" look identical to the backend -- both are just `exists:
// false` -- but they are opposite situations: a hub tab for the PRD or
// CLAUDE.md opens on a file that only gets created by the first save, so
// "not there" is its normal starting state, while a file that WAS there
// and is now gone means someone deleted or moved it and the buffer on
// screen is the only copy left.
export type ExternalReadVerdict = "present" | "deleted" | "absent";

export function classifyExternalRead(input: {
  existsNow: boolean;
  existedBefore: boolean;
}): ExternalReadVerdict {
  if (input.existsNow) return "present";
  return input.existedBefore ? "deleted" : "absent";
}

export type ExternalChangeVerdict = "ignore" | "reload" | "conflict";

// Content-based, never time-based (D26): our own save trips the watcher,
// and a timing window would be defeated by a slow disk.
//
// `onDisk` is the content this editor last READ from or WROTE to the path
// -- what it believes is there -- and it, not the buffer, is what decides
// whether an event is news. Comparing against the buffer alone made every
// autosave a false alarm: the watcher debounces 500ms
// (FILE_WATCH_DEBOUNCE) before reporting our own write, and a human
// typing has moved the buffer on well inside that window, so the echo
// came back looking exactly like somebody else's edit to a dirty file.
// The buffer comparison stays as a second escape hatch -- if the disk
// already holds what the user is holding, there is nothing to reconcile
// however it got there.
export function resolveExternalChange(input: {
  incoming: string;
  buffer: string;
  onDisk: string;
  dirty: boolean;
}): ExternalChangeVerdict {
  if (input.incoming === input.onDisk) return "ignore";
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
