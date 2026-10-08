<script lang="ts">
  // The bundle's one page: connect to the Workstation, then draw whichever
  // surface the Companion's own view says. Every decision is in a module
  // (state/workstation.ts, state/entry.ts); this is the template over them.
  import { onMount } from "svelte";
  import { verdictAttentionStatusById } from "$lib/agents/verdictAttention";
  import AppDialog from "$lib/core/AppDialog.svelte";
  import { layoutState } from "$lib/core/layoutState";
  import { workspaceAgentsSummary } from "$lib/sidebar/sidebarSummary";
  import { DEMO_PACE_MS, deviceStorage, openChannel } from "$companion/state/entry";
  import { reachability, reachabilityLine } from "$companion/state/reachability";
  import { SURFACE_LABELS } from "$companion/state/viewState";
  import {
    connection,
    connectWorkstation,
    landing,
    openWorkspace,
    placeFiles,
    returnToHub,
    showScreen,
    showSurface,
    showWorkspaces,
    view,
  } from "$companion/state/workstation";
  import PhoneAddWorkspace from "$companion/surfaces/PhoneAddWorkspace.svelte";
  import PhoneAppSettings from "$companion/surfaces/PhoneAppSettings.svelte";
  import PhoneBoard from "$companion/surfaces/PhoneBoard.svelte";
  import PhoneCard from "$companion/surfaces/PhoneCard.svelte";
  import PhoneFiles from "$companion/surfaces/PhoneFiles.svelte";
  import PhoneGit from "$companion/surfaces/PhoneGit.svelte";
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import PhoneItems from "$companion/surfaces/PhoneItems.svelte";
  import PhonePrd from "$companion/surfaces/PhonePrd.svelte";
  import PhoneRails from "$companion/surfaces/PhoneRails.svelte";
  import PhoneSessions from "$companion/surfaces/PhoneSessions.svelte";
  import PhoneTerminal from "$companion/surfaces/PhoneTerminal.svelte";
  import PhoneWorkspaceSettings from "$companion/surfaces/PhoneWorkspaceSettings.svelte";
  import SurfaceTabs from "$companion/surfaces/SurfaceTabs.svelte";
  import { trackVisibleArea } from "$companion/surfaces/viewport";
  import WorkspaceList from "$companion/surfaces/WorkspaceList.svelte";

  // Counted, never compared: a connection that finishes after the page
  // has moved on (a retry, a teardown) must not become the live one.
  let attempt = 0;
  let disconnect: (() => void) | null = null;
  let pace: ReturnType<typeof setInterval> | null = null;

  function leave(): void {
    attempt += 1;
    if (pace !== null) clearInterval(pace);
    pace = null;
    disconnect?.();
    disconnect = null;
  }

  function connect(): void {
    leave();
    const mine = attempt;
    const opened = openChannel();
    // A Demo Workstation hosted in this page is this page's to keep
    // moving; one behind the shell's channel is the shell's.
    if (opened.demo) pace = setInterval(() => opened.demo?.advance(), DEMO_PACE_MS);
    void connectWorkstation(opened.port, deviceStorage()).then((stop) => {
      if (mine === attempt) disconnect = stop;
      else stop();
    });
  }

  onMount(() => {
    connect();
    const stopTracking = trackVisibleArea();
    return () => {
      stopTracking();
      leave();
    };
  });

  const open = $derived($layoutState.workspaces.find((w) => w.id === $view.workspaceId) ?? null);
  // What a page over the board is drawn afresh for: another card, or the
  // PRD. A card whose file moved is the same card, found by its name, and
  // keeps what its page holds.
  const pageKey = $derived(
    $view.page?.kind === "card" ? $view.page.path.slice($view.page.path.lastIndexOf("/") + 1) : ($view.page?.kind ?? null)
  );
  const ready = $derived($connection.status === "ready" ? $connection : null);
  const offline = $derived(ready ? reachabilityLine($reachability, ready.workstation.name) : null);
  const waiting = $derived(
    open
      ? workspaceAgentsSummary(open, {
          sessionStatusById: $verdictAttentionStatusById,
          fileTabsById: $layoutState.fileTabsById,
          boardTabsById: $layoutState.boardTabsById,
          cardTabsById: $layoutState.cardTabsById,
        }).waiting
      : 0
  );
</script>

<main class="companion" class:offline={offline !== null}>
  <!-- The one place an outage is said: above whatever screen is up, which
       keeps its place and its drafts, and reads again by itself once the
       Workstation is back (state/reachability.ts). -->
  {#if offline}
    <p class="offline-line" role="status">{offline}</p>
  {/if}
  {#if $connection.status === "connecting"}
    <PhoneHeader title="Gavin" />
    <p class="note">Connecting to the Workstation…</p>
  {:else if $connection.status === "unavailable"}
    <PhoneHeader title="Gavin" />
    <div class="note">
      <p class="problem">This Workstation cannot be reached: {$connection.reason}.</p>
      <p>Gavin’s desktop app has to be running there. Open it at the desk, then try again.</p>
      <button type="button" class="action" onclick={connect}>Try again</button>
    </div>
  {:else if ready}
    <!-- The surfaces draw under a boundary: a surface that throws while it
         is being created otherwise leaves the last one on screen and says
         nothing, and a phone has no console to look in. -->
    <svelte:boundary>
      {#if open && $view.sessionId}
        {#key $view.sessionId}
          <PhoneTerminal sessionId={$view.sessionId} />
        {/key}
      {:else if open && $view.page}
        {#key `${open.id}:${pageKey}`}
          {#if $view.page.kind === "card"}
            <PhoneCard workspace={open} path={$view.page.path} back={SURFACE_LABELS[$view.surface]} />
          {:else}
            <PhonePrd workspace={open} />
          {/if}
        {/key}
      {:else if open}
        <!-- One band, the header and the strip, which a phone on its
             side folds into one row (below). -->
        <div class="chrome">
          <PhoneHeader
            title={open.name}
            back="Workspaces"
            onBack={showWorkspaces}
            tag={ready.workstation.demo ? "demo" : null}
          />
          <SurfaceTabs current={$view.surface} onPick={showSurface} {waiting} />
        </div>
        <!-- Keyed on the root as well: a workspace pointed at another
             folder at the desk is another repository and another tree. -->
        {#key `${open.id}\u0000${open.rootPath ?? ""}`}
          {#if $view.surface === "sessions"}
            <div class="scroll">
              <PhoneSessions workspace={open} />
            </div>
          {:else if $view.surface === "rails"}
            <PhoneRails workspace={open} />
          {:else if $view.surface === "decisions"}
            <PhoneItems workspace={open} kind="decisions" />
          {:else if $view.surface === "review"}
            <PhoneItems workspace={open} kind="tests" />
          {:else if $view.surface === "git"}
            <PhoneGit workspace={open} />
          {:else if $view.surface === "files"}
            <PhoneFiles workspace={open} place={$view.files} onPlace={placeFiles} />
          {:else if $view.surface === "settings"}
            <PhoneWorkspaceSettings workspace={open} />
          {:else}
            <PhoneBoard workspace={open} landing={$landing} />
          {/if}
        {/key}
      {:else if $view.screen === "settings"}
        <PhoneHeader title="Settings" back="Workspaces" onBack={showWorkspaces} tag={ready.workstation.demo ? "demo" : null} />
        <PhoneAppSettings />
      {:else if $view.screen === "add-workspace"}
        <PhoneHeader title="Add a workspace" back="Workspaces" onBack={showWorkspaces} tag={ready.workstation.demo ? "demo" : null} />
        <PhoneAddWorkspace />
      {:else}
        <PhoneHeader
          title={ready.workstation.name || "Workstation"}
          back={ready.canReturnToHub ? "Workstations" : null}
          onBack={ready.canReturnToHub ? () => void returnToHub() : null}
          tag={ready.workstation.demo ? "demo" : null}
          onSettings={() => showScreen("settings")}
        />
        <div class="scroll">
          <WorkspaceList onOpen={openWorkspace} onAdd={() => showScreen("add-workspace")} />
        </div>
      {/if}

      {#snippet failed(error, reset)}
        <PhoneHeader title="Gavin" back="Workspaces" onBack={showWorkspaces} />
        <div class="note">
          <p class="problem">This screen could not be drawn.</p>
          <p class="detail">{error instanceof Error ? error.message : String(error)}</p>
          <button type="button" class="action" onclick={reset}>Draw it again</button>
        </div>
      {/snippet}
    </svelte:boundary>
  {/if}
</main>

<!-- The one confirm and alert layer, as at the desk (dialog.ts). Outside
     the boundary, so a surface that failed can still say why. -->
<AppDialog />

<style>
  .companion {
    display: flex;
    flex-direction: column;
    height: 100vh;
    /* The height that follows the browser's own bars, where there is
       one; the line above is for a webview that does not know it. The
       visible height (viewport.ts) goes further, and leaves out the soft
       keyboard: a page that did not would type under it. */
    height: var(--visible-height, 100dvh);
    /* Clear of the side insets, the Dynamic Island's band and the
       rounded corners of a phone on its side (62px each way on an iPhone
       16 Pro, 0 upright), once for every surface: none of them reads a
       side inset of its own. A sheet fixed over the page spans these
       too, and keeps clear itself (PhoneCompose.svelte).
       `seam/landscape.test.ts` holds it. */
    padding: 0 env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
    box-sizing: border-box;
    transform: translateY(var(--visible-top, 0px));
  }
  .offline-line {
    flex: 0 0 auto;
    margin: 0;
    padding: calc(env(safe-area-inset-top) + 4px) 12px 4px;
    border-bottom: 1px solid var(--border-warning);
    background: var(--surface-warning);
    color: var(--warning-text);
    font-size: 0.75rem;
    line-height: 1.4;
  }
  /* The line has taken the notch's inset; the header under it need not
     (PhoneHeader.svelte reads this). */
  .companion.offline {
    --header-inset-top: 0px;
  }
  .chrome {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
  }
  /* A phone on its side is 402px tall on an iPhone 16 Pro, and the
     header over the strip took 94 of them: one row, the header's title
     beside the strip. A tablet's landscape is tall enough to keep both. */
  @media (orientation: landscape) and (max-height: 500px) {
    .companion .chrome {
      flex-direction: row;
      border-bottom: 1px solid var(--border);
      background: var(--surface-sunken);
    }
    .companion .chrome > :global(*) {
      border-bottom: 0;
    }
    .companion .chrome > :global(:first-child) {
      flex: 0 1 auto;
      max-width: 40%;
    }
    .companion .chrome > :global(:last-child) {
      flex: 1 1 0;
      min-width: 0;
    }
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: env(safe-area-inset-bottom);
    overflow-y: auto;
  }
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .note p {
    margin: 0 0 12px;
  }
  .problem {
    color: var(--danger-text);
  }
  .detail {
    overflow-wrap: anywhere;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .action {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .action:active {
    background: var(--surface-hover);
  }
  .action:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
