// The app's context menu (same family as tooltip.ts / ConfirmPrompt):
// one store, one ContextMenu.svelte layer mounted at the app root
// (+page.svelte), shared by kanban cards/columns, pane tabs, and the
// sidebar. Callers build a flat item list -- separators group, danger
// styles red, a disabled item shows but ignores clicks -- and open it
// with openContextMenuFromEvent.

import { writable } from "svelte/store";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  // A checkmark-style marker (e.g. the card's current column).
  active?: boolean;
  onPick: () => void;
}

export type ContextMenuEntry = ContextMenuItem | { separator: true };

export interface ContextMenuState {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}

export const contextMenu = writable<ContextMenuState | null>(null);

export function openContextMenu(x: number, y: number, entries: ContextMenuEntry[]): void {
  const hasAction = entries.some((e) => !("separator" in e));
  contextMenu.set(hasAction ? { x, y, entries } : null);
}

// The one call every right-click handler needs: claim the event (no
// native menu, no bubbling to an outer surface's own handler) and open
// the shared menu at the pointer. Surfaces only build their entries.
export function openContextMenuFromEvent(e: MouseEvent, entries: ContextMenuEntry[]): void {
  e.preventDefault();
  e.stopPropagation();
  openContextMenu(e.clientX, e.clientY, entries);
}

export function closeContextMenu(): void {
  contextMenu.set(null);
}

export function isSeparator(entry: ContextMenuEntry): entry is { separator: true } {
  return "separator" in entry;
}
