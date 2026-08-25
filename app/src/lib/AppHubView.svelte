<script lang="ts">
  // The app hub: a fleet overview above every workspace. A thin template
  // over appHub.ts (order, ages, links), sidebarSummary.ts (the per-row
  // recap) and workspaceCreate.ts (the one creation flow) -- it decides
  // nothing itself, which is what keeps a hub row and the sidebar row
  // for the same workspace from ever disagreeing.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { Plus, SquareArrowOutUpRight } from "@lucide/svelte";
  import { layoutState, switchWorkspace, daemonCompat } from "./layoutState";
  import { workspaceAgentsSummary } from "./sidebarSummary";
  import { recentWorkspaces, relativeTime, appLinks, workspaceRecapLine, APP_VERSION } from "./appHub";
  import {
    newWorkspaceFlow,
    startCreatingWorkspace,
    setNewWorkspaceName,
    commitNewWorkspace,
    cancelNewWorkspace,
  } from "./workspaceCreate";
  import { accentVar } from "./settings";
  import { themeState } from "./ui/themeState.svelte";

  // Sampled once per render of the hub rather than ticked: the ages here
  // are "2m ago"-coarse, and a timer redrawing the whole list every
  // second to move one of them would cost more than it tells anyone.
  // Reopening the hub re-samples it.
  const now = Date.now();

  const recents = $derived(recentWorkspaces($layoutState.workspaces));
  const links = appLinks();

  let nameInput: HTMLInputElement | null = $state(null);
  // Only the box this surface opened -- the sidebar renders one from the
  // same store, and it is still on screen behind the hub.
  const naming = $derived($newWorkspaceFlow.naming?.surface === "hub" ? $newWorkspaceFlow.naming : null);

  $effect(() => {
    if (naming && nameInput) nameInput.focus();
  });

  const daemonLine = $derived($daemonCompat ? ` · daemon protocol v${$daemonCompat.daemonVersion}` : "");

  function recap(workspaceId: string): string {
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    return ws ? workspaceRecapLine(workspaceAgentsSummary(ws, $layoutState)) : "";
  }
</script>

<div class="hub">
  <header>
    <h1>Gavin</h1>
    <!-- The daemon's protocol version only once it is known: the hub can
         be on screen before the compat probe answers, and "v0" would be
         a lie rather than a placeholder. -->
    <p class="version">v{APP_VERSION}{daemonLine}</p>
  </header>

  <section class="recents">
    <h2>Recent workspaces</h2>
    <div class="rows">
      {#each recents as ws (ws.id)}
        <button
          type="button"
          class="row"
          class:current={ws.id === $layoutState.activeWorkspaceId}
          style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
          onclick={() => void switchWorkspace(ws.id)}
        >
          <span class="row-main">
            <span class="name">{ws.name}</span>
            <span class="recap">{recap(ws.id)}</span>
          </span>
          <span class="row-detail">
            <!-- An unrooted workspace says so rather than showing an
                 empty gap: "no folder" is the reason its hub tabs are
                 mostly greyed out, and this is where you notice. -->
            <span class="root">{ws.rootPath ?? "no folder"}</span>
            <span class="age">{relativeTime(ws.lastActiveAt, now)}</span>
          </span>
        </button>
      {/each}
    </div>

    {#if naming}
      <input
        class="new-name"
        aria-label="New workspace name"
        placeholder="Workspace name"
        bind:this={nameInput}
        value={naming.name}
        oninput={(e) => setNewWorkspaceName(e.currentTarget.value)}
        onblur={() => void commitNewWorkspace()}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitNewWorkspace();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelNewWorkspace();
          }
        }}
      />
    {:else}
      <button type="button" class="new" onclick={() => startCreatingWorkspace("hub")}>
        <Plus size={13} />
        New workspace…
      </button>
    {/if}
  </section>

  <footer>
    <!-- appLinks() has already dropped every entry without a url --
         that is how the website row stays out until there is a site to
         point it at -- and the guard below is what proves it to the
         type checker rather than a second policy. -->
    {#each links as link (link.id)}
      {@const url = link.url}
      {#if url}
        <button type="button" class="link" onclick={() => void openUrl(url)}>
          {link.label}
          <SquareArrowOutUpRight size={11} />
        </button>
      {/if}
    {/each}
  </footer>
</div>

<style>
  .hub {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 28px 24px 16px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    font-family: monospace;
    color: var(--text);
  }
  header {
    flex: 0 0 auto;
  }
  h1 {
    margin: 0;
    font-size: 1.5em;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .version {
    margin: 3px 0 0;
    color: var(--text-subtle);
    font-size: 0.78em;
  }
  h2 {
    margin: 0 0 8px;
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 0.7em;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .recents {
    flex: 1 1 auto;
    min-height: 0;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: stretch;
    text-align: left;
    /* The accent stripe the sidebar row for this workspace also carries,
       so the two lists read as the same fleet. */
    border: 1px solid var(--border);
    border-left: 3px solid var(--row-accent);
    border-radius: 6px;
    background: var(--surface-sunken);
    color: var(--text);
    padding: 8px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.82em;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.current {
    border-color: var(--border-strong);
    border-left-color: var(--row-accent);
  }
  .row-main,
  .row-detail {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recap,
  .age {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .root {
    color: var(--text-subtle);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new,
  .new-name {
    margin-top: 8px;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    color: var(--text-muted);
    padding: 8px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.82em;
  }
  .new:hover {
    color: var(--text);
    background: var(--surface-hover);
  }
  .new-name {
    border-style: solid;
    border-color: var(--border-focus);
    background: var(--surface-sunken);
    color: var(--text);
    cursor: text;
  }
  .new-name:focus {
    outline: none;
  }
  footer {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .link {
    display: flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    padding: 0;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.78em;
  }
  .link:hover {
    color: var(--text);
  }
</style>
