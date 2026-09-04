export function folderName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : cwd;
}

// The same session display-name fallback chain Pane.svelte's tab labels
// use: a custom name override, then the last path segment of the session's
// known cwd, then a short id fragment. Exported so notifications.ts (via
// layoutState.ts, see that module's own notes) can build a readable
// notification body without duplicating this chain.
export function sessionLabel(
  sessionNames: Record<string, string>,
  cwdBySessionId: Record<string, string>,
  sessionId: string
): string {
  const customName = sessionNames[sessionId];
  if (customName) return customName;
  const cwd = cwdBySessionId[sessionId];
  return cwd ? folderName(cwd) : sessionId.slice(0, 8);
}

// A board tab's label, in the one place both the tab bar and the sidebar's
// page expansion can read it: the context's name from the tree, falling
// back to its folder's own basename when the tree has not loaded yet (or
// no longer lists that context). Exact information either way, which is
// why a board tab -- like a file tab -- is never renameable.
export function boardTabLabel(contextName: string | null | undefined, contextFolder: string): string {
  return `${contextName || folderName(contextFolder)} · board`;
}

// A card tab's label: the card's own title, plus which of its two views
// this pane holds. Same shape and same reasoning as boardTabLabel -- the
// tab bar and the sidebar's page expansion both read it, and neither
// half may invent a second name for the same pane. `title` falls back to
// the card's file name when the tree has not loaded (or no longer lists
// the card), so the label is never empty.
export function cardTabLabel(title: string, view: "plan" | "changes"): string {
  return `${title} · ${view === "plan" ? "plan" : "changes"}`;
}
