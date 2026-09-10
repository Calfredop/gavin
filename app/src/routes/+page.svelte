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
  import { openContextMenuFromEvent } from "$lib/contextMenu";
  import HubTabsModal from "$lib/HubTabsModal.svelte";
  import { buildHubTabMenuEntries } from "$lib/hubTabMenu";
  import AppDialog from "$lib/AppDialog.svelte";
  import ReviewDialog from "$lib/ReviewDialog.svelte";
  import { confirmWindowClose } from "$lib/appClose";
  import { getActiveWorkspace, getActiveView, getActiveTree, hubLabel } from "$lib/workspace";
  import { gavinTrees } from "$lib/gavinState";
  import {
    agentProfilesStore,
    agentModelDefaultsStore,
    trustedAgentConfigs,
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
  import { sidebarCollapsed } from "$lib/sidebarPrefs";
  import { tabStripHubViews, visibleHubViews } from "$lib/workspaceViews";
  import TerminalView from "$lib/TerminalView.svelte";
  import TitleBar from "$lib/TitleBar.svelte";
  import WindowResizeEdges from "$lib/WindowResizeEdges.svelte";
  import NewPageButton from "$lib/NewPageButton.svelte";
  import OpenInWindowButton from "$lib/OpenInWindowButton.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Sidebar from "$lib/Sidebar.svelte";
  import CornerOverhang from "$lib/CornerOverhang.svelte";
  import { isMacSync } from "$lib/platform";
  import AppHubView from "$lib/AppHubView.svelte";
  import WorkspaceRootControl from "$lib/WorkspaceRootControl.svelte";
  import DaemonCompatBanner from "$lib/DaemonCompatBanner.svelte";
  import DaemonRequestErrorBanner from "$lib/DaemonRequestErrorBanner.svelte";
  import MemoryPressureBanner from "$lib/MemoryPressureBanner.svelte";
  import { adoptAgentCommits, agentCommitPhase, gitStore } from "$lib/gitState";
  import { hubViewBusy, hubViewAttention, moveHubViewId } from "$lib/hubViewMeta";
  import {
    hubTabOrderByWorkspace,
    hubTabPrefsFor,
    hubTabsHiddenByWorkspace,
    hubTabsHiddenDefault,
    hubTabsUnlocked,
    setWorkspaceHubTabOrder,
    setWorkspaceHubTabsHidden,
    toggleHubTabsUnlocked,
  } from "$lib/hubTabPrefs";
  import { getDragKind, getDragPayload, setDragPayload } from "$lib/dragDrop";
  import { Lock, LockOpen } from "@lucide/svelte";
  import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestrationState";
  import { railsWantingAttention, emptyOrchestration } from "$lib/orchestration";
  import { tooltip } from "$lib/tooltip";
  import { wheelScrollsSideways, scrollsIntoLead } from "$lib/wheelScroll";
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
  // Whether this window has to draw a header row of its own. These are
  // the branches that have none -- the two connection states, the app
  // hub, a window with no workspace, and a workspace whose page has no
  // panes yet -- and a window's top edge has two jobs it cannot go
  // without: leaving room for whatever of the window's corner overhangs
  // a collapsed rail, and offering somewhere to grab the window.
  const needsChromeRow = $derived(
    $layoutState.status !== "ready" ||
      $appHubOpen ||
      !activeWorkspace ||
      (activeView === "terminal" && getActiveTree($layoutState) === null)
  );
  // Not HUB_VIEWS directly: a view that edits files under the bound root
  // must never appear in a workspace that has no root.
  const hubViews = $derived(visibleHubViews(Boolean(activeWorkspace?.rootPath)));
  // This workspace's own arrangement of the row: the order it was dragged
  // into, and the hidden set it keeps or inherits from the app-wide
  // default. Handed to tabStripHubViews rather than applied here, so the
  // strip, the ⌘-digit router and both settings panels all derive the row
  // from the one rule.
  const hubTabPrefs = $derived(
    hubTabPrefsFor(
      activeWorkspace?.id ?? "",
      $hubTabOrderByWorkspace,
      $hubTabsHiddenByWorkspace,
      $hubTabsHiddenDefault
    )
  );
  // What the strip draws. Settings is offered (it is in hubViews, and
  // activeViewDef below still resolves it) but is reached by the gear in
  // the row's actions rather than by a tab -- so this list, not hubViews,
  // is what the tabs and their ⌘-digit badges are counted from.
  const tabViews = $derived(tabStripHubViews(Boolean(activeWorkspace?.rootPath), hubTabPrefs));
  const settingsView = $derived(hubViews.find((v) => v.id === "settings") ?? null);
  // Which views this row can point AT: the tabs it draws, plus the ones
  // reached by a button. A workspace parked on a tab that has since been
  // hidden would otherwise keep rendering it with nothing in the row
  // underlined -- reachable until the human clicked away, and then not
  // at all. It falls back to the first tab instead.
  const drawableViews = $derived(
    new Set([...tabViews.map((v) => v.id), ...hubViews.filter((v) => v.viaAction).map((v) => v.id)])
  );
  const activeViewDef = $derived(
    (drawableViews.has(activeView) ? hubViews.find((v) => v.id === activeView) : undefined) ??
      tabViews[0]
  );
  // Resolved once: the agent-file tab's label, and (via normalizeColor)
  // the accent every tab indicator in this workspace reads.
  const activeAgent = $derived(
    resolveAgentConfig(
      $trustedAgentConfigs(activeWorkspace?.id ?? ""),
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

  // Where a tab would land if it were dropped right now. Cleared on
  // leave, end and drop, exactly as the pane row's own reorder marker is.
  let hubTabDrop = $state<{ viewId: string; position: "before" | "after" } | null>(null);

  function handleHubTabDragStart(event: DragEvent, viewId: string): void {
    if (!activeWorkspace) return;
    setDragPayload(event, { kind: "hub-tab", workspaceId: activeWorkspace.id, viewId });
  }

  function handleHubTabDragOver(event: DragEvent, viewId: string): void {
    if (getDragKind(event) !== "hub-tab") return;
    event.preventDefault();
    // Without an explicit dropEffect the app shows the "copy" (+) cursor
    // even though the source set effectAllowed -- it has to be set on the
    // TARGET's dragover. See Pane.svelte's tab row, which learned this
    // the same way.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    hubTabDrop = { viewId, position: dropSide(event) };
  }

  function dropSide(event: DragEvent): "before" | "after" {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return (event.clientX - rect.left) / rect.width < 0.5 ? "before" : "after";
  }

  function clearHubTabDrop(): void {
    hubTabDrop = null;
  }

  function handleHubTabDrop(event: DragEvent, viewId: string): void {
    event.preventDefault();
    // Recomputed from the drop itself rather than read off the hover
    // marker: the pointer can cross the tab's midpoint between the last
    // dragover and the release.
    const position = dropSide(event);
    const payload = getDragPayload(event);
    hubTabDrop = null;
    if (!payload || payload.kind !== "hub-tab" || !activeWorkspace) return;
    // Never across workspaces: the strip is only ever drawn for the
    // active one, but a payload naming another one would rearrange a row
    // nobody is looking at.
    if (payload.workspaceId !== activeWorkspace.id) return;
    setWorkspaceHubTabOrder(
      activeWorkspace.id,
      moveHubViewId(hubTabPrefs.order, payload.viewId, viewId, position)
    );
  }

  // The eye list, opened from the tab menu rather than from Settings.
  // Mounted here beside the other app-level modals so it outlives the
  // menu that asked for it.
  let hubTabsPanelOpen = $state(false);

  // Right-click on a tab: hide it, put a hidden one back, or open the
  // full list. Behind the same padlock as dragging, because it is the
  // same kind of edit -- while the row is locked a tab is a button and
  // nothing about it moves or disappears, and a right-click falls
  // through to whatever the app does with one anywhere else.
  function handleHubTabMenu(event: MouseEvent, viewId: string): void {
    if (!$hubTabsUnlocked || !activeWorkspace) return;
    const workspaceId = activeWorkspace.id;
    openContextMenuFromEvent(
      event,
      buildHubTabMenuEntries(
        {
          viewId,
          hasRoot: Boolean(activeWorkspace.rootPath),
          // The EFFECTIVE set, so a workspace that is inheriting the
          // app-wide default starts from what its row actually draws.
          hidden: hubTabPrefs.hidden ?? [],
          order: hubTabPrefs.order,
          agentFile: activeAgent.file,
        },
        {
          // This workspace's own list, never the app-wide default: the
          // gesture happened in one strip, and a right-click must not
          // rearrange the four rows nobody is looking at.
          setHidden: (hidden) => setWorkspaceHubTabsHidden(workspaceId, hidden),
          manage: () => (hubTabsPanelOpen = true),
        }
      )
    );
  }

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
        // Asks, and -- if the human ticked the box -- ends every session
        // before returning, because a destroyed window has no frontend
        // left to await the kills with.
        shouldClose = await confirmWindowClose();
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
<div
  class="app"
  class:sidebar-collapsed={$sidebarCollapsed}
  class:wide-window-controls={!isMacSync()}
  style:--ws-accent={accent}
>
  <!-- Outside the body row and ahead of every connection branch, for
       the same reason TitleBar is: a window that cannot reach its
       daemon still has to be resizable. Draws nothing on macOS, whose
       borderless windows keep the OS's own edge drag. -->
  <WindowResizeEdges />
  <div class="body">
    <!-- The window's own column: its top line -- the window's controls
         in a corner of their own, over the rail's own top row -- and the
         sidebar under both. It is the whole reason the hub and the page
         beside it reach the top of the window: the strip used to span
         the app and push everything down by its own height.

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
      <!-- Above the banners, because it is the top edge of the window on
           every branch that draws it. Its height is the shared header
           height, so the sidebar beside it starts on the same line here
           as it does under a row of tabs. -->
      {#if needsChromeRow}
        <div class="chrome-row">
          <CornerOverhang />
          <div class="drag-spacer" use:windowDrag></div>
        </div>
      {/if}
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
        <!-- And beside those two for the same reason again: the machine
             is at critical pressure and gavin is holding new launches,
             which is a caveat on a working app. It never kills anything.
             Above the boundary, like the other two: this is the app's own
             report channel and has to survive whatever the views throw. -->
        <MemoryPressureBanner />
        <!-- Every view the window can draw, under one boundary.
             Deliberately NOT around the banners above it: those are the
             app's own report channel and have to survive whatever this
             catches.

             Without it a view that throws while it is being CREATED is
             invisible. Svelte builds the new branch of an `{#if}` before
             it tears the old one down (BranchManager.ensure, then
             #commit), so a throw on the way in leaves the previous
             branch exactly where it was -- while the chrome row above,
             a separate block that already committed, flips to the new
             branch's shape. Pressing the sidebar's Gavin row then puts
             a blank header bar over the page you were already on, which
             is indistinguishable from a dead button and leaves nothing
             to report but "nothing happened".

             So: say what broke, keep the rest of the window alive, and
             offer the retry -- `reset()` re-renders the children, which
             is the whole recovery when the cause was a hot reload that
             left one module half-applied. -->
        <svelte:boundary onerror={(error) => console.error("view render failed", error)}>
          {#snippet failed(error, reset)}
            <div class="overlay">
              <p>This view couldn&rsquo;t be drawn.</p>
              <p class="detail">{error instanceof Error ? error.message : String(error)}</p>
              <button onclick={reset}>Try again</button>
            </div>
          {/snippet}
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
                <!-- The window's own chrome leads the row, before the
                     workspace's tabs and outside the scroller: this row is
                     the top edge of the window, and a collapse toggle that
                     could scroll out of reach would be a rail with no way
                     back. A rule after it, so what acts on the WINDOW is
                     not read as the first tab of the workspace. -->
                <CornerOverhang />
                <!-- The tabs scroll; what follows them does not. A
                     workspace with a root offers nine of them, and the
                     button that adds a page must not be the first thing a
                     narrow window pushes out of reach. -->
                <div class="tab-strip" use:wheelScrollsSideways>
                  {#each tabViews as view, viewIndex (view.id)}
                    {@const busy = hubViewBusy(view.id, activity)}
                    {@const wantsYou = hubViewAttention(view.id, activity)}
                    <button
                      type="button"
                      class="tab"
                      class:active={activeViewDef?.id === view.id}
                      class:arrangeable={$hubTabsUnlocked}
                      class:drop-before={hubTabDrop?.viewId === view.id &&
                        hubTabDrop.position === "before"}
                      class:drop-after={hubTabDrop?.viewId === view.id &&
                        hubTabDrop.position === "after"}
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
                      draggable={$hubTabsUnlocked}
                      ondragstart={(e) => handleHubTabDragStart(e, view.id)}
                      ondragover={(e) => handleHubTabDragOver(e, view.id)}
                      ondragleave={clearHubTabDrop}
                      ondragend={clearHubTabDrop}
                      ondrop={(e) => handleHubTabDrop(e, view.id)}
                      oncontextmenu={(e) => handleHubTabMenu(e, view.id)}
                      onclick={() => switchWorkspaceView(activeWorkspace.id, view.id)}
                      use:scrollsIntoLead={activeViewDef?.id === view.id}
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
                        {@const digit = hintDigitFor(viewIndex, tabViews.length)}
                        {#if digit !== null}
                          <ShortcutHint text={String(digit)} />
                        {/if}
                      {/if}
                    </button>
                  {/each}
                </div>
                <!-- At the end of the tabs, and OUTSIDE the scroller: the
                     lock is what makes the row draggable at all, so a
                     narrow window must never be able to push it out of
                     reach. Locked is the resting state -- a tab row that
                     rearranged itself whenever a click drifted would move
                     the thing you were aiming at. The padlock shows the
                     state it is IN, not the action -- open means the row
                     is loose right now, which is the thing worth noticing
                     at a glance. It is also the gate on the tabs'
                     right-click menu, which is why the locked label says
                     what the unlock is FOR rather than just "rearrange". -->
                <IconButton
                  icon={$hubTabsUnlocked ? LockOpen : Lock}
                  label={$hubTabsUnlocked ? "Lock the tab row" : "Rearrange or hide the tabs"}
                  size={12}
                  class="arrange-toggle"
                  active={$hubTabsUnlocked}
                  onclick={toggleHubTabsUnlocked}
                />
                <!-- What the window lost when the title strip came down to
                     the sidebar's width: somewhere roomy to grab it. The
                     run of bar after the last tab moves the window, the way
                     an empty toolbar does on macOS. A pane's tab row now
                     does the same with its own leftover -- see
                     windowDrag.ts. -->
                <div class="drag-spacer" use:windowDrag></div>
                <div class="tab-actions">
                  <!-- The workspace's own settings, off the strip and into
                       the actions: it is the thing you open to change
                       something and then leave, not a view you work in,
                       and as a tab it ranked with Kanban and Git and cost
                       every one of them a place. `active` is what says it
                       is the view on screen, since it has no tab left to
                       underline. -->
                  {#if settingsView}
                    <IconButton
                      icon={settingsView.icon}
                      label="Workspace settings"
                      size={14}
                      active={activeViewDef?.id === settingsView.id}
                      onclick={() => switchWorkspaceView(activeWorkspace.id, settingsView.id)}
                    />
                  {/if}
                  <!-- Last before the rule, and deliberately: it acts on
                       the workspace rather than on what is inside it, and it
                       decides WHERE the workspace is before the + adds to
                       it. -->
                  <OpenInWindowButton />
                  <!-- Behind a rule, like the pane row's own: everything
                       left of it acts on THIS workspace, and what follows
                       adds a page to it. -->
                  <span class="divider"></span>
                  <NewPageButton />
                </div>
              </div>
              <div class="view">
                <activeViewDef.component workspaceId={activeWorkspace.id} />
              </div>
            </div>
          {/if}
        </svelte:boundary>
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

<!-- The same eye list the two Settings panels open, reached here from a
     tab's own right-click menu. App-level rather than inside the row: the
     menu that asks for it is dismissed by the very click that picks the
     entry, so a modal owned by the strip would be opened and unmounted in
     the same gesture. -->
{#if hubTabsPanelOpen && activeWorkspace}
  <HubTabsModal workspaceId={activeWorkspace.id} onClose={() => (hubTabsPanelOpen = false)} />
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
    /* How wide the window's own column is, open and collapsed. A
       variable rather than two rules on .rail because the head of the
       header row reads it too: it has to know how much of the window's
       corner overhangs a narrow rail to leave room for it. */
    --rail-width: var(--sidebar-width);
    /* And how wide that corner is -- the platform's own controls. macOS
       draws three 12px lights 8px apart inside a 12px pad; everything
       else three 26px tiles 2px apart inside an 8px/6px pad. Stated
       rather than measured because the row beside the corner has to
       leave room for it before either has been laid out. Keep in step
       with WindowControls.svelte -- windowControls.test.ts adds the
       tiles up and checks the total against the value below. */
    --window-corner-width: 76px;
  }
  .app.wide-window-controls {
    --window-corner-width: 96px;
  }
  .app.sidebar-collapsed {
    --rail-width: var(--rail-collapsed-width);
  }
  .body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: row;
    min-height: 0;
  }
  /* The window's column: the rail's top line, then the sidebar filling
     the rest -- and, floated over its top-left corner and out of its
     flow, the window's own controls (TitleBar.svelte). The width and the
     divider live here rather than on the sidebar so the rule between the
     two columns runs the full height of the window.

     Collapsed, this narrows to an icon rail; it never goes away. It
     cannot: it is the only place the workspace list exists, and the
     toggle back out of the rail is a row in it. What sets the collapsed
     width is what the rail draws -- a chip and its padding. It used to
     be the platform's: the window controls sat in a strip inside this
     column, so 76px of traffic lights (120 off macOS) was the narrowest
     it could ever go, whatever the rows measured. */
  .rail {
    flex: 0 0 auto;
    width: var(--rail-width);
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface-raised);
    border-right: 1px solid var(--border);
    /* What the peeking sidebar is positioned against: a press on the
       collapsed rail floats the full column over the view beside it
       rather than widening this one, so the anchor has to be the column
       and the overlay has to be inside it. */
    position: relative;
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
  /* The tab row's stand-in on the branches that have no tabs. Same
     height, same surface, same top pad -- whichever of the two is on
     screen, the sidebar beside it starts on the same line and the view
     under it starts on the next one. */
  .chrome-row {
    display: flex;
    align-items: center;
    height: var(--header-height);
    box-sizing: border-box;
    padding: var(--header-pad-top) 10px 0;
    flex: 0 0 auto;
    background: var(--surface-base);
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
    /* The same surface as the view under it, stated rather than
       inherited from .app: a page's tab row has to be able to name the
       colour it must match, and a row that only inherits gives it
       nothing to match against. */
    background: var(--surface-base);
  }
  /* Grows only as far as its tabs: the leftover belongs to the drag
     spacer, so an empty stretch of this row moves the window instead of
     being dead space inside a scroller. */
  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: var(--tab-gap);
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
  /* The pane row's rule, to the pixel (Pane.svelte's .divider): it
     groups the actions by what they act on without spending a row of
     labels on saying so. */
  .divider {
    width: 1px;
    align-self: center;
    height: var(--tab-divider);
    margin: 0 3px;
    background: var(--border);
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
  /* The only thing separating two tabs on a flat bar. Down the middle
     of the gap (half of it, negated), and short of the row's height, so
     it reads as a separator rather than as a box around each tab. Off
     .tab, which is already `position: relative` for the hold-⌘ hint. */
  .tab + .tab::before {
    content: "";
    position: absolute;
    left: calc(var(--tab-gap) / -2);
    top: 50%;
    height: var(--tab-divider);
    width: 1px;
    transform: translateY(-50%);
    background: var(--border);
  }
  /* Says the row is live without moving anything: the tabs stay exactly
     where they are, and only the cursor changes. */
  .tab.arrangeable {
    cursor: grab;
  }
  .tab.arrangeable:active {
    cursor: grabbing;
  }
  /* The pane row's own insertion marks, to the pixel (Pane.svelte's
     .tab.drop-before/.drop-after): one gesture, one piece of feedback,
     wherever a tab is being dragged. */
  .tab.drop-before {
    box-shadow: inset 2px 0 0 0 var(--ws-accent, #4a9eff);
  }
  .tab.drop-after {
    box-shadow: inset -2px 0 0 0 var(--ws-accent, #4a9eff);
  }
  /* Deliberately smaller than a tab: it acts ON the row rather than
     being one of its destinations, and a control the same size as the
     tabs would read as a tenth tab. */
  .tabs :global(.arrange-toggle) {
    flex: 0 0 auto;
    align-self: center;
    margin-left: 6px;
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
