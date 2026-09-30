<script lang="ts">
  // The bundle's one page: connect to the Workstation, then draw whichever
  // surface the Companion's own view says. Every decision is in a module
  // (state/workstation.ts, state/entry.ts); this is the template over them.
  import { onMount } from "svelte";
  import { layoutState } from "$lib/core/layoutState";
  import { DEMO_PACE_MS, deviceStorage, openChannel } from "$companion/state/entry";
  import {
    connection,
    connectWorkstation,
    landing,
    openWorkspace,
    placeFiles,
    returnToHub,
    showSurface,
    showWorkspaces,
    view,
  } from "$companion/state/workstation";
  import PhoneBoard from "$companion/surfaces/PhoneBoard.svelte";
  import PhoneFiles from "$companion/surfaces/PhoneFiles.svelte";
  import PhoneGit from "$companion/surfaces/PhoneGit.svelte";
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import SurfaceTabs from "$companion/surfaces/SurfaceTabs.svelte";
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
    return leave;
  });

  const open = $derived($layoutState.workspaces.find((w) => w.id === $view.workspaceId) ?? null);
  const ready = $derived($connection.status === "ready" ? $connection : null);
</script>

<main class="companion">
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
      {#if open}
        <PhoneHeader
          title={open.name}
          back="Workspaces"
          onBack={showWorkspaces}
          tag={ready.workstation.demo ? "demo" : null}
        />
        <SurfaceTabs current={$view.surface} onPick={showSurface} />
        <!-- Keyed on the root as well: a workspace pointed at another
             folder at the desk is another repository and another tree. -->
        {#key `${open.id}\u0000${open.rootPath ?? ""}`}
          {#if $view.surface === "git"}
            <PhoneGit workspace={open} />
          {:else if $view.surface === "files"}
            <PhoneFiles workspace={open} place={$view.files} onPlace={placeFiles} />
          {:else}
            <PhoneBoard workspace={open} landing={$landing} />
          {/if}
        {/key}
      {:else}
        <PhoneHeader
          title={ready.workstation.name || "Workstation"}
          back={ready.canReturnToHub ? "Workstations" : null}
          onBack={ready.canReturnToHub ? () => void returnToHub() : null}
          tag={ready.workstation.demo ? "demo" : null}
        />
        <div class="scroll">
          <WorkspaceList onOpen={openWorkspace} />
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

<style>
  .companion {
    display: flex;
    flex-direction: column;
    height: 100vh;
    /* The height that follows the browser's own bars, where there is
       one; the line above is for a webview that does not know it. */
    height: 100dvh;
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
