<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import {
    layoutState,
    bootstrap,
    teardown,
    createWorkspace,
    switchWorkspaceView,
    retryConnect,
  } from "$lib/layoutState";
  import { signalFrontendReady } from "$lib/backend";
  import { installKeyboardShortcuts } from "$lib/keyboard";
  import { installHintTracking, hintMode } from "$lib/shortcutHints";
  import { hintDigitFor } from "$lib/shortcuts";
  import ShortcutHint from "$lib/ui/ShortcutHint.svelte";
  import ContextMenu from "$lib/ContextMenu.svelte";
  import { getActiveWorkspace, getActiveView, hubLabel } from "$lib/workspace";
  import { gavinTrees } from "$lib/gavinState";
  import { agentProfilesStore } from "$lib/layoutState";
  import { resolveAgentConfig, accentVar } from "$lib/settings";
  import { themeState } from "$lib/ui/themeState.svelte";
  import { visibleHubViews } from "$lib/workspaceViews";
  import TerminalView from "$lib/TerminalView.svelte";
  import TitleBar from "$lib/TitleBar.svelte";
  import Sidebar from "$lib/Sidebar.svelte";
  import WorkspaceRootControl from "$lib/WorkspaceRootControl.svelte";

  let closeConfirmed = false;
  let uninstallShortcuts: (() => void) | null = null;
  let uninstallHints: (() => void) | null = null;
  let unlistenClose: (() => void) | null = null;

  const activeWorkspace = $derived(getActiveWorkspace($layoutState));
  const activeView = $derived(activeWorkspace ? getActiveView(activeWorkspace) : "terminal");
  // Not HUB_VIEWS directly: dev-only views (the smoke-test checklist)
  // must never appear in a real workspace or a release build.
  const hubViews = $derived(
    visibleHubViews(activeWorkspace?.id ?? "", import.meta.env.DEV, Boolean(activeWorkspace?.rootPath))
  );
  const activeViewDef = $derived(hubViews.find((v) => v.id === activeView) ?? hubViews[0]);
  // Resolved once: the agent-file tab's label, and (via normalizeColor)
  // the accent every tab indicator in this workspace reads.
  const activeAgent = $derived(
    resolveAgentConfig(
      $gavinTrees[activeWorkspace?.id ?? ""]?.contexts.find((c) => c.kind === "root")?.agent ?? null,
      $agentProfilesStore
    )
  );
  const accent = $derived(accentVar(activeWorkspace?.color, themeState.effective));

  async function quitApp(): Promise<void> {
    closeConfirmed = true;
    // destroy(), not close() -- close() would re-dispatch CloseRequested
    // through the very listener intercepting it below.
    await getCurrentWindow().destroy();
  }

  async function createFirstWorkspace(): Promise<void> {
    await createWorkspace("Workspace 1");
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
    uninstallHints = installHintTracking();
  });

  onDestroy(() => {
    unlistenClose?.();
    uninstallShortcuts?.();
    uninstallHints?.();
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
      <button onclick={retryConnect}>Restart daemon &amp; retry</button>
    </div>
  {:else}
    <!-- The active workspace's accent, read by every tab indicator and
         drop marker inside (Pane.svelte's var(--ws-accent)). -->
    <div class="body" style:--ws-accent={accent}>
      <Sidebar />
      {#if !activeWorkspace}
        <div class="overlay">
          <button onclick={createFirstWorkspace}>New Workspace</button>
        </div>
      {:else if activeView === "terminal"}
        <div class="view">
          <TerminalView workspaceId={activeWorkspace.id} />
        </div>
      {:else}
        <div class="content">
          <!-- Above the tabs: the bound folder is the whole workspace's
               context, not a property of whichever page is open. The
               Settings tab embeds this control itself; showing the
               banner there too would double it up. -->
          {#if activeView !== "settings"}
            <WorkspaceRootControl workspace={activeWorkspace} />
          {/if}
          <div class="tabs">
            {#each hubViews as view, viewIndex (view.id)}
              <button
                type="button"
                class="tab"
                class:active={activeView === view.id}
                onclick={() => switchWorkspaceView(activeWorkspace.id, view.id)}
              >
                <view.icon size={14} />
                {hubLabel(view, activeAgent.file)}
                {#if $hintMode === "cmd"}
                  {@const digit = hintDigitFor(viewIndex, hubViews.length)}
                  {#if digit !== null}
                    <ShortcutHint text={String(digit)} />
                  {/if}
                {/if}
              </button>
            {/each}
          </div>
          <div class="view">
            <activeViewDef.component workspaceId={activeWorkspace.id} />
          </div>
        </div>
      {/if}
    </div>
  {/if}
  <!-- The one context-menu layer for the whole app: its store is a
       singleton, so a second mount would draw a duplicate menu. -->
  <ContextMenu />
</div>

<style>
  /* App chrome is not selectable, like a native window. WKWebView only
     honors the -webkit- prefixed property, so the unprefixed one alone
     did nothing on macOS. Real content opts back in below and in the
     components that render it (xterm, CodeMirror, markdown). */
  :global(html, body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
    -webkit-user-select: none;
    user-select: none;
  }
  :global(input, textarea, [contenteditable]:not([contenteditable="false"])) {
    -webkit-user-select: text;
    user-select: text;
  }
  .app {
    width: 100vw;
    height: 100vh;
    margin: 0;
    background: var(--surface-base);
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
  .content {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 6px 10px 0;
    flex: 0 0 auto;
  }
  .tab {
    /* Anchors the hold-⌘ hint badge (absolutely positioned, so holding
       ⌘ never reflows the tab row). */
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    padding: 6px 10px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.85em;
  }
  .tab.active {
    color: var(--text);
    /* The workspace's accent when set; otherwise the original amber, so
       an uncoloured workspace looks exactly as it did before. */
    border-bottom-color: var(--ws-accent, #d9a648);
  }
  .view {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }
  .overlay {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text);
    font-family: monospace;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .overlay button {
    margin-top: 12px;
    padding: 8px 16px;
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
