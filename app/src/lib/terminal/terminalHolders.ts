import { hotState } from "$lib/core/hotState";

/// Which mounted panes are showing each session's one terminal, newest last.
///
/// The registry keeps one xterm per session, and a TerminalPane shows it by
/// moving its container into its own mount point -- so the pane that mounted
/// last has it, and every other pane on that session is left with an empty
/// box. That is harmless while the panes take turns: the old one is torn down
/// as the new one mounts. It is not when they overlap. A hub section opened
/// from a page's navigator (Decisions, Review, Scheduled, ...) is drawn OVER
/// the page, whose panes stay mounted underneath; the section's pane takes
/// the terminal, and when the section closes -- an answered decision moving
/// the selection on, the page's own tab clicked -- the page's pane never
/// remounts, so nothing ever put the terminal back and its tab was blank.
///
/// So a pane registers here as it takes the terminal, and its release hands
/// it back to the most recent holder still mounted -- but only if the
/// released pane was the one showing it. Svelte builds a new branch before it
/// tears the old one down, so a release routinely comes AFTER the successor
/// has taken the terminal, and taking it back then would steal it from the
/// pane on screen.
///
/// Held in `hotState` for the registry's reason: the panes outlive a hot
/// reload of this module, and their releases have to find the stacks.
const stacks = hotState<Map<string, Array<() => void>>>(
  "terminalHolders",
  () => new Map(),
  import.meta.hot?.data
);

/// Records that a pane has just taken `sessionId`'s terminal. `reclaim` is
/// how it takes it back: called when the pane that took it from this one is
/// released. Returns that release; calling it again is a no-op.
export function holdTerminal(sessionId: string, reclaim: () => void): () => void {
  const stack = stacks.get(sessionId) ?? [];
  stack.push(reclaim);
  stacks.set(sessionId, stack);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = stack.indexOf(reclaim);
    if (at === -1) return;
    const wasShowing = at === stack.length - 1;
    stack.splice(at, 1);
    if (stack.length === 0) {
      stacks.delete(sessionId);
      return;
    }
    if (wasShowing) stack[stack.length - 1]();
  };
}
