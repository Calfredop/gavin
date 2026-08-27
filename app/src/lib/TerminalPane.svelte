<script lang="ts">
  import { onMount } from "svelte";
  import * as backend from "./backend";
  import { getOrCreateTerminal, restoreScreen } from "./terminalRegistry";
  import type { Terminal } from "@xterm/xterm";
  import type { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  let { sessionId, visible, focused }: { sessionId: string; visible: boolean; focused: boolean } = $props();

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
    const entry = getOrCreateTerminal(sessionId);
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

<div class="pane" class:inactive={!visible} bind:this={mountPoint}></div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
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
