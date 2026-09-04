<script lang="ts">
  import { onMount, tick } from "svelte";
  import * as backend from "./backend";
  import FollowUpQueue from "./FollowUpQueue.svelte";
  import { queuedInputsById, layoutState } from "./layoutState";
  import { stripVisible } from "./queuedInput";
  import { queueTargetFor } from "./queuedInputActions";
  import { getOrCreateTerminal, restoreScreen, setTerminalFontSize } from "./terminalRegistry";
  import type { Terminal } from "@xterm/xterm";
  import type { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  // `sessionId` is fixed for the life of the component: onMount is what
  // binds it, and nothing below re-reads it. That is deliberate -- the
  // registry's container has to survive a tree-shape remount with its
  // scrollback intact -- but it makes recreating this pane the caller's
  // job whenever the session changes. Hand it a new id in place and it
  // keeps showing the old session while fit() reports that terminal's
  // measurements to the new one. Both call sites therefore rebuild it:
  // Pane.svelte with an {#each} keyed by sessionId, MainAgentPanel with
  // a {#key}. terminalPaneSession.test.ts holds every call site to it.
  let {
    sessionId,
    visible,
    focused,
    fontSize,
  }: { sessionId: string; visible: boolean; focused: boolean; fontSize: number } = $props();

  let mountPoint: HTMLDivElement;
  let term: Terminal;
  let fitAddon: FitAddon;
  // $state, not a plain `let` -- this file uses runes ($props below), so a
  // plain `let` read inside the $effect further down would never establish
  // reactivity and the effect would never re-fire once this flips to true.
  let ready = $state(false);

  // Called by the parent Pane via bind:this whenever this tab's shared
  // pane rectangle changes size -- every tab in a pane gets resized
  // together, not just the active one (see Global Constraints).
  export function fit(): Promise<void> {
    if (!ready) return Promise.resolve();
    fitAddon.fit();
    const { cols, rows } = term;
    return backend.resizeSession(sessionId, cols, rows).catch(() => {});
  }

  onMount(() => {
    const entry = getOrCreateTerminal(sessionId, fontSize);
    term = entry.term;
    fitAddon = entry.fitAddon;
    mountPoint.appendChild(entry.container);

    ready = true;
    // Seeded beside the first fit so the band effect below does not
    // repeat it: the queue strip is rendered before onMount runs, so the
    // measurement this fit takes already accounts for it.
    fittedForStrip = stripShowing;
    // Awaited, not fired and forgotten: the daemon renders a snapshot at the
    // size it believes the PTY is, so the resize has to reach it first. Both
    // requests ride the streaming connection and the daemon reads it in
    // order, so awaiting the resize's own write is enough to sequence them.
    void fit().then(() => restoreScreen(sessionId));
    if (focused) term.focus();
  });

  // The settings panels write a size; this is what carries it to the
  // terminal. Driven from the MOUNTED pane rather than pushed across the
  // registry because a resize is only meaningful for a terminal whose
  // container is in the document -- and an inactive tab's is: it is hidden
  // with `visibility`, so it keeps its rectangle and refits correctly
  // alongside the visible one (the same reason fit() runs for every tab in
  // a pane, not just the active one).
  //
  // The first run is a no-op: onMount already created the terminal at this
  // size, so setTerminalFontSize reports no change and no refit is owed.
  $effect(() => {
    const size = fontSize;
    if (!ready) return;
    if (setTerminalFontSize(sessionId, size)) void fit();
  });

  // Whether the follow-up queue band is taking a slice of this pane.
  //
  // Recomputed here as well as inside FollowUpQueue, and deliberately
  // from the same `stripVisible`: the band changes how much height the
  // terminal has, and xterm only learns a new size from a fit(). Without
  // this the rows the daemon believes the PTY has would stay at the
  // pre-band count, and a full-screen TUI would paint its last lines
  // underneath the strip. The band's own `composerOpen` is not in here,
  // which is the one gap -- the composer grows the band without a refit
  // -- and it is left that way on purpose: it is a transient couple of
  // rows the human is looking straight at, and refitting the PTY under
  // an agent mid-turn is the more expensive mistake.
  const stripShowing = $derived(
    stripVisible(
      queueTargetFor(
        $layoutState.sessionStatusById[sessionId],
        $layoutState.interruptedSessionIds.has(sessionId)
      ),
      ($queuedInputsById[sessionId] ?? []).length,
      false
    )
  );

  // The band state the terminal was last fitted for. A plain `let`, not
  // $state: it must gate the effect below without being a dependency of
  // it, or writing it would re-arm the very effect that wrote it.
  let fittedForStrip: boolean | null = null;

  $effect(() => {
    const showing = stripShowing;
    // Every session in the app has one of these, so an unconditional
    // refit here would be a resize per pane per mount for a rectangle
    // that did not move.
    if (!ready || fittedForStrip === showing) return;
    fittedForStrip = showing;
    // Refit once the band has actually landed in the DOM: fitAddon
    // measures the container, so running before the tick would measure
    // the height it is leaving rather than the one it is taking.
    void tick().then(() => fit());
  });

  // Re-focus whenever this session becomes the one with keyboard focus
  // (tracked by layoutState's focusedSessionId, passed down as `focused` --
  // NOT driven by `visible` alone, which only reflects tab-bar selection
  // within a pane and can't tell "am I the pane the user is typing in").
  $effect(() => {
    if (focused && visible && ready) {
      term.focus();
    }
  });
</script>

<div class="pane" class:inactive={!visible}>
  <div class="term" bind:this={mountPoint}></div>
  <FollowUpQueue {sessionId} />
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* A column, so the queue band takes its height off the terminal
       rather than covering the bottom rows of it. */
    display: flex;
    flex-direction: column;
  }
  .term {
    /* min-height: 0 is load-bearing: without it a flex item refuses to
       shrink below its content, and the band would push the terminal's
       bottom out of the pane instead of taking height from it. */
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .inactive {
    visibility: hidden;
    z-index: 0;
  }
  .pane:not(.inactive) {
    z-index: 1;
  }
  /* Defensive: xterm.js's own selection/copy already runs through its
     internal buffer (term.getSelection(), used by clipboard.ts), not the
     browser's native selection -- so the app-wide `user-select: none`
     shouldn't affect it at all. Re-enabling it here explicitly costs
     nothing and removes any risk that some xterm-internal DOM node (e.g.
     its accessibility helpers) turns out to depend on it after all. */
  :global(.xterm),
  :global(.xterm *) {
    -webkit-user-select: text;
    user-select: text;
  }
</style>
