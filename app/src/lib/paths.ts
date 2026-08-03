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
