<script lang="ts">
  import { onMount } from "svelte";
  import * as backend from "$lib/core/backend";
  import { fitWorthTaking } from "$lib/terminal/terminalFit";
  import { getOrCreateTerminal, restoreScreen, setTerminalFontSize } from "$lib/terminal/terminalRegistry";
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
  //
  // The measurement is checked BEFORE fitAddon.fit(), not after: the
  // damage is inside fit() itself (it reflows the terminal to the shape
  // FitAddon proposed), so a guard on the reported cols/rows would be too
  // late. Every caller -- this pane's own effects, Pane's ResizeObserver,
  // MainAgentPanel, HomeHubView -- comes through here, so this one check
  // covers the whole family. See fitWorthTaking for what an empty box
  // does to a running agent.
  export function fit(): Promise<void> {
    if (!ready) return Promise.resolve();
    if (!fitWorthTaking(mountPoint.clientWidth, mountPoint.clientHeight)) {
      return Promise.resolve();
    }
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
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* Nothing shares this pane with the terminal any more. The follow-up
       queue used to be a band along the bottom of it, which cost the PTY
       between two and eleven rows depending on what was queued; it lives
       in its own split now, opened from the tab-actions row beside the
       plan and the run's diff. */
    display: flex;
    flex-direction: column;
  }
  .term {
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
