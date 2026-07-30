<script lang="ts">
  import { onMount } from "svelte";
  import * as backend from "./backend";
  import { getOrCreateTerminal } from "./terminalRegistry";
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
  export function fit(): void {
    if (!ready) return;
    fitAddon.fit();
    const { cols, rows } = term;
    backend.resizeSession(sessionId, cols, rows).catch(() => {});
  }

  onMount(() => {
    const entry = getOrCreateTerminal(sessionId);
    term = entry.term;
    fitAddon = entry.fitAddon;
    mountPoint.appendChild(entry.container);

    ready = true;
    fit();
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
</style>
