<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { layoutState, bootstrap, teardown, createWorkspace, createPage } from "$lib/layoutState";
  import { signalFrontendReady } from "$lib/backend";
  import { installKeyboardShortcuts } from "$lib/keyboard";
  import { getActiveWorkspace, getActiveTree } from "$lib/workspace";
  import { presetSingle } from "$lib/layout";
  import LayoutTree from "$lib/LayoutTree.svelte";
  import TitleBar from "$lib/TitleBar.svelte";
  import Sidebar from "$lib/Sidebar.svelte";

  let closeConfirmed = false;
  let uninstallShortcuts: (() => void) | null = null;
  let unlistenClose: (() => void) | null = null;

  const activeWorkspace = $derived(getActiveWorkspace($layoutState));
  const activeTree = $derived(getActiveTree($layoutState));

  async function quitApp(): Promise<void> {
    closeConfirmed = true;
    // destroy(), not close() -- close() would re-dispatch CloseRequested
    // through the very listener intercepting it below.
    await getCurrentWindow().destroy();
  }

  async function createFirstWorkspace(): Promise<void> {
    await createWorkspace("Workspace 1");
  }

  async function addPageToActiveWorkspace(): Promise<void> {
    const ws = activeWorkspace;
    if (!ws) return;
    await createPage(ws.id, ([id]) => presetSingle(id), 1, `Page ${ws.pages.length + 1}`);
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
  <TitleBar />
  {#if $layoutState.status === "connecting"}
    <div class="overlay">
      <p>Connecting…</p>
    </div>
  {:else if $layoutState.status === "error"}
    <div class="overlay">
      <p>Couldn't connect to the daemon.</p>
      <p class="detail">{$layoutState.errorMessage}</p>
    </div>
  {:else}
    <div class="body">
      <Sidebar />
      {#if !activeWorkspace}
        <div class="overlay">
          <button onclick={createFirstWorkspace}>New Workspace</button>
        </div>
      {:else if !activeTree}
        <div class="overlay">
          <button onclick={addPageToActiveWorkspace}>New Page</button>
        </div>
      {:else}
        <div class="tree">
          <LayoutTree node={activeTree} path={[]} />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
    user-select: none;
  }
  .app {
    width: 100vw;
    height: 100vh;
    margin: 0;
    background: #1e1e1e;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    overflow: hidden;
  }
  .body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: row;
    min-height: 0;
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
