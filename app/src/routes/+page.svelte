<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { layoutState, bootstrap, teardown, newSessionFromEmpty } from "$lib/layoutState";
  import { signalFrontendReady } from "$lib/backend";
  import { installKeyboardShortcuts } from "$lib/keyboard";
  import LayoutTree from "$lib/LayoutTree.svelte";
  import Toolbar from "$lib/Toolbar.svelte";

  let closeConfirmed = false;
  let uninstallShortcuts: (() => void) | null = null;
  let unlistenClose: (() => void) | null = null;

  async function quitApp(): Promise<void> {
    closeConfirmed = true;
    // destroy(), not close() -- close() would re-dispatch CloseRequested
    // through the very listener intercepting it below.
    await getCurrentWindow().destroy();
  }

  onMount(async () => {
    unlistenClose = await getCurrentWindow().onCloseRequested(async (event) => {
      if (closeConfirmed) return;
      event.preventDefault();
      const shouldClose = await confirm(
        "Close this window? Your terminal sessions will keep running — reopen the app to resume them.",
        { title: "gavin" }
      );
      if (shouldClose) {
        await quitApp();
      }
    });

    try {
      await bootstrap();
    } finally {
      await signalFrontendReady();
    }

    uninstallShortcuts = installKeyboardShortcuts();
  });

  onDestroy(() => {
    unlistenClose?.();
    uninstallShortcuts?.();
    teardown();
  });
</script>

<div class="app">
  {#if $layoutState.status === "connecting"}
    <div class="overlay">
      <p>Connecting…</p>
    </div>
  {:else if $layoutState.status === "error"}
    <div class="overlay">
      <p>Couldn't connect to the daemon.</p>
      <p class="detail">{$layoutState.errorMessage}</p>
    </div>
  {:else if $layoutState.tree}
    <Toolbar />
    <div class="tree">
      <LayoutTree node={$layoutState.tree} path={[]} />
    </div>
  {:else}
    <div class="overlay">
      <button onclick={newSessionFromEmpty}>New Session</button>
    </div>
  {/if}
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
  .app {
    width: 100vw;
    height: 100vh;
    margin: 0;
    background: #1e1e1e;
    display: flex;
    flex-direction: column;
  }
  .tree {
    flex: 1 1 auto;
    position: relative;
  }
  .overlay {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #eee;
    font-family: monospace;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .overlay button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #3a3a3a;
    border: none;
    color: #eee;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
