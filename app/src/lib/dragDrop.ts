// Discriminates what's being dragged. For "pane"/"tab", sessionId is the
// dragged content's identity within its source page: for "pane" it's any
// one of that pane's tab session ids (used with detachLeaf, which locates
// the whole leaf from any single tab inside it); for "tab" it's that
// specific tab's session id (used with detachTab). workspaceId/pageId
// always identify the SOURCE location -- the page the drag started
// from, which is always the currently active page, since that's the only
// page ever rendered.
export type DragPayload =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "page"; workspaceId: string; pageId: string }
  | { kind: "pane"; workspaceId: string; pageId: string; sessionId: string }
  | { kind: "tab"; workspaceId: string; pageId: string; sessionId: string }
  | { kind: "kanban-card"; cardId: string; sourceColumnId: string }
  | { kind: "kanban-column"; columnId: string }
  | { kind: "plan-card"; path: string };

const DRAG_TYPE_PREFIX = "application/x-gavin-drag-";
const DRAG_KINDS: readonly DragPayload["kind"][] = [
  "workspace",
  "page",
  "pane",
  "tab",
  "kanban-card",
  "kanban-column",
  "plan-card",
];

export function setDragPayload(event: DragEvent, payload: DragPayload): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(DRAG_TYPE_PREFIX + payload.kind, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "move";
}

// Readable during dragover (dataTransfer.types is always available,
// unlike getData's value) -- use this to decide which hover-overlay style
// to show without needing the full payload yet.
export function getDragKind(event: DragEvent): DragPayload["kind"] | null {
  const types = event.dataTransfer?.types ?? [];
  for (const kind of DRAG_KINDS) {
    if (types.includes(DRAG_TYPE_PREFIX + kind)) return kind;
  }
  return null;
}

// Only reliably readable at drop time (see this file's module-level
// background above).
export function getDragPayload(event: DragEvent): DragPayload | null {
  const kind = getDragKind(event);
  if (!kind) return null;
  const raw = event.dataTransfer?.getData(DRAG_TYPE_PREFIX + kind);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

// Given a drop target's bounding rect and the current pointer position,
// computes which of the 5 zones the pointer is over: outer ~25% bands on
// each edge for a directional split, the center ~50% for "add as tab."
export function computeDropZone(rect: DOMRect, clientX: number, clientY: number): DropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const EDGE = 0.25;
  if (x < EDGE) return "left";
  if (x > 1 - EDGE) return "right";
  if (y < EDGE) return "top";
  if (y > 1 - EDGE) return "bottom";
  return "center";
}

export type ReorderPosition = "before" | "after";

// Given a sidebar row's bounding rect and the current pointer Y position,
// computes whether a reordering drop should insert before or after that
// row -- the simple top-half/bottom-half split used for list reordering,
// distinct from computeDropZone's 5-way split used for grafting a
// pane/tab onto a page.
export function computeReorderPosition(rect: DOMRect, clientY: number): ReorderPosition {
  const y = (clientY - rect.top) / rect.height;
  return y < 0.5 ? "before" : "after";
}
