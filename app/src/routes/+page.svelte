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
    appHubOpen,
  } from "$lib/layoutState";
  import { signalFrontendReady } from "$lib/backend";
  import { installKeyboardShortcuts } from "$lib/keyboard";
  import { installHintTracking, hintMode } from "$lib/shortcutHints";
  import { hintDigitFor } from "$lib/shortcuts";
  import ShortcutHint from "$lib/ui/ShortcutHint.svelte";
  import ContextMenu from "$lib/ContextMenu.svelte";
  import { getActiveWorkspace, getActiveView, hubLabel } from "$lib/workspace";
  import { gavinTrees } from "$lib/gavinState";
  import {
    agentProfilesStore,
    agentModelDefaultsStore,
    wizardWorkspaceId,
  } from "$lib/layoutState";
  import SetupWizard from "$lib/SetupWizard.svelte";
  import WorkspaceCreateModal from "$lib/WorkspaceCreateModal.svelte";
  import { newWorkspaceFlow, skipSetup, finishSetup } from "$lib/workspaceCreate";
  import { resolveAgentConfig, accentVar } from "$lib/settings";
  import { themeState } from "$lib/ui/themeState.svelte";
  import { visibleHubViews } from "$lib/workspaceViews";
  import TerminalView from "$lib/TerminalView.svelte";
  import TitleBar from "$lib/TitleBar.svelte";
  import Sidebar from "$lib/Sidebar.svelte";
  import AppHubView from "$lib/AppHubView.svelte";
  import WorkspaceRootControl from "$lib/WorkspaceRootControl.svelte";
  import DaemonCompatBanner from "$lib/DaemonCompatBanner.svelte";
  import DaemonRequestErrorBanner from "$lib/DaemonRequestErrorBanner.svelte";
  import { adoptAgentCommits, agentCommitPhase, gitStore } from "$lib/gitState";
  import { hubViewBusy, hubViewAttention } from "$lib/hubViewMeta";
  import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestrationState";
  import { railsWantingAttention, emptyOrchestration } from "$lib/orchestration";
  import { tooltip } from "$lib/tooltip";

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
      $agentProfilesStore,
      $agentModelDefaultsStore
    )
  );
  const accent = $derived(accentVar(activeWorkspace?.color, themeState.effective));
  // What the tab strip can report as running. The commit agent is a
  // HIDDEN session with no tab of its own, so its Git tab is the only
  // place the app can show it from while another tab is on screen.
  const commitPhase = $derived(agentCommitPhase($gitStore[activeWorkspace?.id ?? ""] ?? null));
  const activity = $derived({
    committing: commitPhase === "starting" || commitPhase === "running",
    railsWantingAttention: activeWorkspace
      ? (railsWantingAttention(
          $orchestrations[activeWorkspace.id] ?? emptyOrchestration(),
          $stepAttentionsByWorkspace[activeWorkspace.id] ?? new Map()
        ).size > 0)
      : false,
  });

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

    // After the ready signal, not before: adoption attaches to a session,
    // and the daemon starts pushing its output the moment it does --
    // which the relay thread holds back until the frontend says its
    // listeners are up.
    void adoptAgentCommits();

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
    <!-- A degraded-but-usable daemon connection is a caveat
         on a working app, not an error -- rendered here in the working
         branch, spanning above the sidebar so it stays visible regardless
         of which workspace or tab is active. -->
    <DaemonCompatBanner />
    <!-- Beside the compat banner, and for the same reason: a request
         the daemon refused is a caveat on a working app, not a lost
         connection, so it never belongs in the error branch above. -->
    <DaemonRequestErrorBanner />
    <!-- The active workspace's accent, read by every tab indicator and
         drop marker inside (Pane.svelte's var(--ws-accent)). -->
    <div class="body" style:--ws-accent={accent}>
      <Sidebar />
      <!-- Ahead of every workspace branch, not inside one: the hub is
           app-level -- it belongs to no workspace, and it must be
           reachable with one open as well as with none. Switching to a
           workspace clears the flag (layoutState's activateWorkspace),
           so nothing here has to close it. -->
      {#if $appHubOpen}
        <div class="view">
          <AppHubView />
        </div>
      {:else if !activeWorkspace}
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
              {@const busy = hubViewBusy(view.id, activity)}
              {@const wantsYou = hubViewAttention(view.id, activity)}
              <button
                type="button"
                class="tab"
                class:active={activeView === view.id}
                use:tooltip={busy
                  ? "An agent is committing"
                  : wantsYou
                    ? "A rail is waiting on you"
                    : ""}
                aria-label={busy
                  ? `${hubLabel(view, activeAgent.file)} — an agent is committing`
                  : wantsYou
                    ? `${hubLabel(view, activeAgent.file)} — a rail is waiting on you`
                    : undefined}
                onclick={() => switchWorkspaceView(activeWorkspace.id, view.id)}
              >
                <!-- In the icon's place, not beside it: the tab row must
                     not reflow when a run starts or ends. -->
                {#if busy}
                  <span class="tab-spinner" aria-hidden="true"></span>
                {:else}
                  <view.icon size={14} />
                {/if}
                {hubLabel(view, activeAgent.file)}
                <!-- A dot, not a spinner: the rail is not the one working,
                     the human is. Absolutely positioned so the tab row
                     never reflows when a rail starts or stops wanting
                     something. -->
                {#if wantsYou}
                  <span class="tab-attention" aria-hidden="true"></span>
                {/if}
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

<!-- App-level, beside the wizard it hands off to, rather than inside
     whichever surface started the flow: the sidebar and the app hub both
     create workspaces, and the modal has to outlive the one that opened
     it (the hub closes the moment its new workspace becomes active). -->
{#if $newWorkspaceFlow.pendingSetupId}
  <WorkspaceCreateModal
    workspaceId={$newWorkspaceFlow.pendingSetupId}
    onSkip={skipSetup}
    onDone={finishSetup}
  />
{/if}

{#if $wizardWorkspaceId}
  <SetupWizard workspaceId={$wizardWorkspaceId} />
{/if}

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
  .tab-spinner {
    width: 10px;
    height: 10px;
    flex: 0 0 auto;
    margin: 2px;
    border: 2px solid var(--border-accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: tab-spin 0.8s linear infinite;
  }
  @keyframes tab-spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* Warning tone, matching the rail header, the chip ring and the
     sidebar count it stands in for. Positioned off .tab, which is
     already `position: relative` for the hold-⌘ hint. */
  .tab-attention {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warning-text);
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
