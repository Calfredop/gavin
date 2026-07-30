<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import * as backend from "./backend";
  import { registerTerminal, unregisterTerminal } from "./terminalRegistry";

  let { sessionId, visible }: { sessionId: string; visible: boolean } = $props();

  let container: HTMLDivElement;
  let term: Terminal;
  let fitAddon: FitAddon;
  // $state, not a plain `let` -- this file uses runes ($props below), so a
  // plain `let` read inside the $effect further down would never establish
  // reactivity and the effect would never re-fire once this flips to true.
  let ready = $state(false);
  const unlisteners: UnlistenFn[] = [];

  // Called by the parent Pane via bind:this whenever this tab's shared
  // pane rectangle changes size -- every tab in a pane gets resized
  // together, not just the active one (see Global Constraints).
  export function fit(): void {
    if (!ready) return;
    fitAddon.fit();
    const { cols, rows } = term;
    backend.resizeSession(sessionId, cols, rows).catch(() => {});
  }

  onMount(async () => {
    term = new Terminal({ convertEol: false });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    registerTerminal(sessionId, term);

    term.onData((data) => {
      backend.writeInput(sessionId, data).catch(() => {});
    });

    unlisteners.push(
      await listen<[string, string]>("pty-output", (event) => {
        const [id, data] = event.payload;
        if (id !== sessionId) return;
        term.write(data);
      })
    );

    ready = true;
    fit();
    if (visible) term.focus();
  });

  onDestroy(() => {
    unlisteners.forEach((unlisten) => unlisten());
    unregisterTerminal(sessionId);
    term?.dispose();
  });

  $effect(() => {
    if (visible && ready) {
      term.focus();
    }
  });
</script>

<div class="pane" class:inactive={!visible} bind:this={container}></div>

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
