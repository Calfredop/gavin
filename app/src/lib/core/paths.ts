// Every path gavin holds uses forward slashes: the daemon and the Tauri
// host both normalise on the way out (protocol::wire_path), which is
// what lets the ~40 modules that take a path apart with split("/") stay
// correct on Windows. These helpers accept a backslash anyway, because
// the one path that does NOT come through that boundary is the one a
// human types into a field.
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

// A path that names its own root: `/x` on unix, `C:\x` or `C:/x` or a
// `\\server\share` UNC on Windows. Both alphabets on both platforms,
// deliberately -- the app runs on one OS but reads paths written on
// another (a card's `cwd`, a tool's directory, a config committed by a
// colleague), and judging those by the running platform would call a
// perfectly good absolute path relative.
export function isAbsolutePath(path: string): boolean {
  const trimmed = path.trim();
  return (
    trimmed.startsWith("/") || trimmed.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(trimmed)
  );
}

export function folderName(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
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

// A card tab's label: the card's own title, plus which of its views this
// pane holds. Same shape and same reasoning as boardTabLabel -- the tab
// bar and the sidebar's page expansion both read it, and neither half
// may invent a second name for the same pane. `title` falls back to the
// card's file name when the tree has not loaded (or no longer lists the
// card), so the label is never empty.
export function cardTabLabel(title: string, view: "plan" | "changes"): string {
  return `${title} · ${view === "plan" ? "plan" : "changes"}`;
}

// The follow-up queue's tab, whose subject is a session rather than a
// card -- so it is named after the terminal it belongs to, by the very
// label that terminal's own tab wears. Separate from cardTabLabel
// because there is no card and no title to fall back on: the caller
// resolves the session's name with sessionLabel and hands it here.
export function followUpsTabLabel(sessionName: string): string {
  return `${sessionName} · follow-ups`;
}
