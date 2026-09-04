<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
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
  import { installLineClipboard } from "$lib/lineClipboard";
  import { installHintTracking, hintMode } from "$lib/shortcutHints";
  import { hintDigitFor } from "$lib/shortcuts";
  import ShortcutHint from "$lib/ui/ShortcutHint.svelte";
  import ContextMenu from "$lib/ContextMenu.svelte";
  import AppDialog from "$lib/AppDialog.svelte";
  import ReviewDialog from "$lib/ReviewDialog.svelte";
  import { askConfirm } from "$lib/dialog";
  import { getActiveWorkspace, getActiveView, hubLabel } from "$lib/workspace";
  import { gavinTrees } from "$lib/gavinState";
  import {
    agentProfilesStore,
    agentModelDefaultsStore,
    wizardWorkspaceId,
  } from "$lib/layoutState";
  import SetupWizard from "$lib/SetupWizard.svelte";
  import WorkspaceCreateModal from "$lib/WorkspaceCreateModal.svelte";
  import BestOfNDialog from "$lib/BestOfNDialog.svelte";
  import { bestOfNRequest, hydrateRuns } from "$lib/bestOfNState";
  import { showAlert } from "$lib/dialog";
  import { newWorkspaceFlow, skipSetup, finishSetup } from "$lib/workspaceCreate";
  import { resolveAgentConfig, accentVar } from "$lib/settings";
  import { themeState } from "$lib/ui/themeState.svelte";
  import { visibleHubViews } from "$lib/workspaceViews";
  import TerminalView from "$lib/TerminalView.svelte";
  import TitleBar from "$lib/TitleBar.svelte";
  import NewPageButton from "$lib/NewPageButton.svelte";
  import OpenInWindowButton from "$lib/OpenInWindowButton.svelte";
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
  import { wheelScrollsSideways } from "$lib/wheelScroll";
  import { windowDrag } from "$lib/windowDrag";
  import { isMainWindow } from "$lib/appWindowState";

  let closeConfirmed = false;
  // The prompt is a DOM modal now, so the window can keep sending close
  // requests while it is up (⌘Q, the Dock). Without this, each one
  // queues another identical question behind the first.
  let closePromptOpen = false;
  let uninstallShortcuts: (() => void) | null = null;
  let uninstallHints: (() => void) | null = null;
  let uninstallLineClipboard: (() => void) | null = null;
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

  // Best-of-N runs come back from localStorage, once per workspace. Here
  // rather than in a board component because the card context menu reads
  // the store on every open and this page is the only thing always
  // mounted; hydrating from a hub view would mean a menu built before
  // that view was ever visited offers a second run over a live one.
  const hydratedRuns = new Set<string>();
  $effect(() => {
    for (const ws of $layoutState.workspaces) {
      if (hydratedRuns.has(ws.id)) continue;
      hydratedRuns.add(ws.id);
      hydrateRuns(ws.id);
    }
  });
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
      // A workspace window closes without a question. The prompt below
      // exists because closing the main window is how you put gavin away;
      // closing a workspace window puts nothing away -- its workspaces go
      // straight back to the window they came from, and not one session
      // is touched.
      if (!isMainWindow()) return;
      event.preventDefault();
      if (closePromptOpen) return;
      closePromptOpen = true;
      let shouldClose = false;
      try {
        shouldClose = await askConfirm({
          title: "Close this window?",
          lines: ["Your terminal sessions keep running — reopen the app to resume them."],
          confirmLabel: "Close window",
          cancelLabel: "Keep open",
        });
      } finally {
        closePromptOpen = false;
      }
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
    uninstallLineClipboard = installLineClipboard();
  });

  onDestroy(() => {
    unlistenClose?.();
    uninstallShortcuts?.();
    uninstallHints?.();
    uninstallLineClipboard?.();
    teardown();
  });
</script>

<!-- The active workspace's accent, read by every tab indicator and drop
     marker inside (Pane.svelte's var(--ws-accent)). On .app rather than
     on the body row below it, so the strip over the sidebar is inside
     it too. -->
<div class="app" style:--ws-accent={accent}>
  <div class="body">
    <!-- The window's own column: the title strip, and the sidebar under
         it. It is the whole reason the hub and the page beside it reach
         the top of the window -- the strip used to span the app and push
         everything down by its own height.

         Ahead of the connection branches, not inside the working one: a
         window that cannot reach its daemon still has to be movable,
         zoomable and closable. -->
    <div class="rail">
      <TitleBar />
      {#if $layoutState.status === "ready"}
        <Sidebar />
      {/if}
    </div>
    <div class="main">
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
        <!-- A degraded-but-usable daemon connection is a caveat on a
             working app, not an error -- rendered here in the working
             branch, above every workspace branch so it stays visible
             regardless of which workspace or tab is active. -->
        <DaemonCompatBanner />
        <!-- Beside the compat banner, and for the same reason: a request
             the daemon refused is a caveat on a working app, not a lost
             connection, so it never belongs in the error branch above. -->
        <DaemonRequestErrorBanner />
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
            <!-- Above the tabs: an unbound or missing root is the whole
                 workspace's problem, not a property of whichever page is
                 open. A healthy root renders nothing here (D64) -- the path
                 itself is Settings' to state. The Settings tab embeds this
                 control itself; showing the banner there too would double
                 it up. -->
            {#if activeView !== "settings"}
              <WorkspaceRootControl workspace={activeWorkspace} />
            {/if}
            <div class="tabs">
              <!-- The tabs scroll; what follows them does not. A
                   workspace with a root offers nine of them, and the
                   button that adds a page must not be the first thing a
                   narrow window pushes out of reach. -->
              <div class="tab-strip" use:wheelScrollsSideways>
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
              <!-- What the window lost when the title strip came down to
                   the sidebar's width: somewhere roomy to grab it. The
                   run of bar after the last tab moves the window, the way
                   an empty toolbar does on macOS. A pane's tab row
                   pointedly does not (there, empty bar means "drag this
                   pane") -- see windowDrag.ts. -->
              <div class="drag-spacer" use:windowDrag></div>
              <div class="tab-actions">
                <!-- Before the +, and deliberately: both act on the
                     workspace rather than on what is inside it, and this
                     one decides WHERE the workspace is before the other
                     adds to it. -->
                <OpenInWindowButton />
                <NewPageButton />
              </div>
            </div>
            <div class="view">
              <activeViewDef.component workspaceId={activeWorkspace.id} />
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </div>
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

<!-- The best-of-N dialog, mounted once for the same reason as the
     workspace modal above: three surfaces build the card context menu
     that opens it, and a copy inside each of them would be three
     dialogs whose lifetime is tied to whichever board is still
     rendered. The card comes in through the store. -->
{#if $bestOfNRequest}
  <BestOfNDialog
    workspaceId={$bestOfNRequest.workspaceId}
    card={$bestOfNRequest.card}
    onClose={() => bestOfNRequest.set(null)}
    onError={(message) => showAlert({ title: "Couldn't start the run", lines: [message] })}
  />
{/if}

<!-- The app's alerts and confirms, drawn once, here. Last in the
     document on purpose: every other modal is a fixed layer at the same
     z-index, so tree order is what decides, and a question raised from
     inside one of them (archiving a card from its detail modal) has to
     land on top of it rather than behind it. -->
<!-- The review base question, drawn once for the two surfaces that ask
     it (the Git toolbar, and a card's menu on any of the three boards).
     Before AppDialog for the same tree-order reason: an alert raised
     from inside this one has to land on top of it. -->
<ReviewDialog />

<AppDialog />

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
  /* The window's column: title strip on top, sidebar filling the rest.
     The width and the divider live here rather than on the sidebar, so
     the strip above it is the same width and the rule between the two
     columns runs the full height of the window. */
  .rail {
    flex: 0 0 auto;
    width: 200px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface-raised);
    border-right: 1px solid var(--border);
  }
  /* Everything that is not the window's own column, from the top of the
     window down: the banners, and whichever of the app hub, a hub tab or
     a page is on screen. */
  .main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .content {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  /* One of the app's three header rows (see theme.css): this one, a
     pane's tab row, and the strip over the sidebar are the same height
     to the pixel, because whichever is on screen is the top edge of the
     window and switching between them must not move the view under it. */
  .tabs {
    display: flex;
    align-items: stretch;
    height: var(--header-height);
    box-sizing: border-box;
    padding: var(--header-pad-top) 10px 0;
    flex: 0 0 auto;
  }
  /* Grows only as far as its tabs: the leftover belongs to the drag
     spacer, so an empty stretch of this row moves the window instead of
     being dead space inside a scroller. */
  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: 4px;
    flex: 0 1 auto;
    min-width: 0;
    overflow-x: auto;
    /* No visible scrollbar: an overlay bar would sit exactly on the
       active tab's indicator, in a row this short. wheelScrollsSideways
       is what reaches the tabs it hides. */
    scrollbar-width: none;
  }
  .tab-strip::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
  .drag-spacer {
    flex: 1 1 auto;
  }
  .tab-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    padding-left: 6px;
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
    border-bottom: var(--tab-indicator) solid transparent;
    color: var(--text-muted);
    padding: var(--tab-pad);
    cursor: pointer;
    font-family: monospace;
    font-size: var(--tab-font-size);
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
  /* Amber, the app's one colour for "this wants a human"
     (ui/indicators.ts) -- the same tone the rail header, the chip ring
     and the sidebar count it stands in for now wear. A corner pip rather
     than an inline badge because the tab already carries a label and an
     icon of its own, and its aria-label and tooltip both name the fact,
     so nothing here rests on the colour alone. Positioned off .tab,
     which is already `position: relative` for the hold-⌘ hint. */
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
