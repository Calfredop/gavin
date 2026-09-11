<script lang="ts">
  import { pickPath } from "./picker";
  import {
    setWorkspaceRoot,
    switchWorkspaceView,
    gitTrackingDefault,
    markGitTrackingAsked,
    recordMcpForeignChoice,
  } from "./layoutState";
  import { INIT_TRACKING_LABEL, resolveGitTracking } from "./gitTracking";
  import { applyInitTracking } from "./workspaceOpen";
  import { gavinTrees } from "./gavinState";
  import { agentProfilesStore, agentModelDefaultsStore, trustedAgentConfigs } from "./layoutState";
  import { resolveAgentConfig } from "./settings";
  import * as backend from "./backend";
  import { foreignMcpServersHash, integrationNote, runIntegration } from "./mcpServerTrust";
  import { UNFILED_WORKSPACE_ID, type Workspace } from "./workspace";
  import Modal from "./Modal.svelte";
  import McpForeignChooser from "./McpForeignChooser.svelte";

  interface Props {
    workspace: Workspace;
    /// "banner" is the hub-wide strip above every tab, which speaks only
    /// when the root is a problem; "settings" is the embedded form row,
    /// which also states the path and drops the banner chrome because the
    /// panel already provides a heading.
    variant?: "banner" | "settings";
  }
  let { workspace, variant = "banner" }: Props = $props();

  // pendingRoot is non-null while the "Initialize gavin here?" modal is up.
  let pendingRoot = $state<string | null>(null);
  // The modal's git tick-box. Seeded from the app-wide default when the
  // modal opens rather than read live, so a change to the default made in
  // another window mid-question does not move the box under the pointer.
  let trackInGit = $state(true);
  let errorMessage = $state<string | null>(null);

  const tree = $derived($gavinTrees[workspace.id]);
  const rootMissing = $derived(Boolean(workspace.rootPath && tree?.rootMissing));
  const agent = $derived(
    resolveAgentConfig(
      $trustedAgentConfigs(workspace.id),
      $agentProfilesStore,
      $agentModelDefaultsStore
    )
  );

  // The banner variant never picks a folder itself (D56) -- it hands the
  // user to the one place that does, so an unbound workspace is still a
  // live path rather than a dead end.
  function openSettings(): void {
    void switchWorkspaceView(workspace.id, "settings");
  }

  async function pickRoot(): Promise<void> {
    errorMessage = null;
    const picked = await pickPath({ directory: true, title: "Choose workspace root" });
    if (typeof picked !== "string") return;
    if (await backend.gavinRootExists(picked)) {
      await setWorkspaceRoot(workspace.id, picked);
    } else {
      trackInGit = resolveGitTracking($gitTrackingDefault);
      pendingRoot = picked;
    }
  }

  async function confirmInit(): Promise<void> {
    if (!pendingRoot) return;
    const root = pendingRoot;
    pendingRoot = null;
    try {
      await backend.initGavinRoot(root, workspace.name);
    } catch (e) {
      errorMessage = `Couldn't initialize gavin: ${e}`;
      return;
    }
    // Shared with the sidebar's own init prompt, so the two routes into a
    // fresh workspace cannot answer the git question differently -- and
    // marked asked on both, so the wizard's git step does not put a
    // question this modal has just put.
    await applyInitTracking(root, trackInGit);
    await markGitTrackingAsked(workspace.id);
    await setWorkspaceRoot(workspace.id, root);
  }

  async function bindWithoutInit(): Promise<void> {
    if (!pendingRoot) return;
    const root = pendingRoot;
    pendingRoot = null;
    await setWorkspaceRoot(workspace.id, root);
  }

  // Agent integration (D20): offered for every rooted, healthy workspace,
  // but only from Settings (D56) -- it is one-time workspace setup, not
  // per-page context. Writes are merge-aware and re-runnable (gavin-managed
  // files updated in place; everything else preserved).
  let setupNote = $state<string | null>(null);
  // Set instead of `setupNote` when the target MCP config names servers
  // gavin did not add and no recorded choice answers this exact set
  // (AG-07) -- the run pauses here until the human picks.
  let pendingForeign = $state<backend.McpForeignServers | null>(null);
  let mcpBusy = $state(false);

  function noteFrom(result: backend.IntegrationResult): string {
    return integrationNote(result, workspace.rootPath);
  }

  async function setupIntegration(): Promise<void> {
    if (!workspace.rootPath) return;
    setupNote = null;
    pendingForeign = null;
    try {
      const result = await runIntegration(workspace.rootPath, agent.file, workspace.mcpForeignServersChoice);
      if (result.mcpForeign) {
        pendingForeign = result.mcpForeign;
      } else {
        setupNote = noteFrom(result);
      }
    } catch (e) {
      setupNote = `Couldn't set up: ${e}`;
    }
  }

  async function chooseMcp(action: "keep" | "isolate"): Promise<void> {
    if (!pendingForeign || !workspace.rootPath) return;
    mcpBusy = true;
    try {
      await recordMcpForeignChoice(workspace.id, {
        hash: foreignMcpServersHash(pendingForeign.servers),
        action,
      });
      const result = await backend.setupAgentIntegration(workspace.rootPath, agent.file, action);
      setupNote = noteFrom(result);
      pendingForeign = null;
    } catch (e) {
      setupNote = `Couldn't set up: ${e}`;
    }
    mcpBusy = false;
  }
</script>

<div class:settings={variant === "settings"}>
{#if workspace.id !== UNFILED_WORKSPACE_ID}
  <!-- Every folder-picking affordance is settings-only (D56), and stating
       the bound path is settings-only too (D64): a healthy root is not
       news, so the banner variant speaks only when the answer is bad, and
       then points at the panel that can fix it. -->
  {#if !workspace.rootPath}
    <div class="banner">
      <span>No root folder set — bind this workspace to a directory to enable gavin features.</span>
      {#if variant === "settings"}
        <button type="button" onclick={pickRoot}>Set root…</button>
      {:else}
        <button type="button" onclick={openSettings}>Open settings</button>
      {/if}
    </div>
  {:else if rootMissing}
    <div class="banner warning">
      <span>Root not found: {workspace.rootPath}</span>
      {#if variant === "settings"}
        <button type="button" onclick={pickRoot}>Re-pick…</button>
      {:else}
        <button type="button" onclick={openSettings}>Open settings</button>
      {/if}
    </div>
  {:else if variant === "settings"}
    <div class="chip" title={workspace.rootPath}>
      <!-- The &lrm; bookends are load-bearing -- see .path below. -->
      <span class="path">&lrm;{workspace.rootPath}&lrm;</span>
      <button type="button" class="gear" onclick={pickRoot} title="Change workspace root">⚙</button>
    </div>
  {/if}
  {#if errorMessage}
    <div class="banner warning"><span>{errorMessage}</span></div>
  {/if}
  <!-- Settings-only (D56), and gated on there being an MCP layout to
       write: without one the run would report MCP config as skipped, so
       the button would half-work rather than work. -->
  {#if variant === "settings" && workspace.rootPath && !rootMissing && agent.mcpSupported}
    <div class="banner seed">
      <span
        >Agent integration — write {agent.mcpConfigFile} and a gavin section in {agent.file} into
        this root.</span
      >
      <button type="button" onclick={setupIntegration}>Set up / update</button>
    </div>
    {#if pendingForeign}
      <McpForeignChooser
        servers={pendingForeign.servers}
        isolateRefusal={pendingForeign.isolateRefusal}
        busy={mcpBusy}
        onKeep={() => void chooseMcp("keep")}
        onIsolate={() => void chooseMcp("isolate")}
      />
    {:else if setupNote}
      <div class="banner seed"><span>{setupNote}</span></div>
    {/if}
  {/if}
{/if}
</div>

{#if pendingRoot}
  <Modal onClose={() => (pendingRoot = null)}>
    <p>Initialize gavin in this folder?</p>
    <p class="detail">{pendingRoot}</p>
    <p class="detail">
      Creates .gavin-root/ with a PRD template, config, and plans/docs/specs folders. Nothing
      existing is overwritten.
    </p>
    <label class="track">
      <input type="checkbox" bind:checked={trackInGit} />
      {INIT_TRACKING_LABEL}
    </label>
    <div class="actions">
      <button type="button" onclick={confirmInit}>Initialize</button>
      <button type="button" onclick={bindWithoutInit}>Bind without initializing</button>
      <button type="button" onclick={() => (pendingRoot = null)}>Cancel</button>
    </div>
  </Modal>
{/if}

<style>
  /* Embedded in the Settings panel: the panel supplies the heading and
     spacing, so the banner chrome would double up. */
  .settings :global(.banner),
  .settings :global(.chip) {
    margin: 0;
    border: none;
    background: transparent;
    padding: 0;
  }
  /* Stripping the chrome also strips the spacing, and Settings is now the
     only home for the agent-integration row -- give the stack some air so
     it does not butt against the path. */
  .settings > * + * {
    margin-top: 8px;
  }
  .track {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0 0;
    font-size: 0.85em;
    color: var(--text-subtle);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    margin: 6px 10px 0;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.8em;
  }
  .banner.warning {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .banner.seed {
    border-color: var(--border-success);
    color: var(--success-text);
  }
  .banner button,
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 10px 0;
    padding: 3px 10px;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.75em;
  }
  .path {
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Ellipsis on the LEFT: a path's tail is its informative end. The cost
       of an RTL paragraph is that "/" is a bidi-neutral, so a leading one
       has no strong character before it and resolves to the paragraph's
       direction -- it detaches from the path and parks at the far right,
       rendering /Users/x/gavin as "Users/x/gavin/". The &lrm; bookends in
       the markup are strong-LTR, so the slashes sit inside the LTR run and
       stay where they were typed. */
    direction: rtl;
  }
  .gear {
    background: transparent;
    border: none;
    color: var(--text-subtle);
    cursor: pointer;
    padding: 0 2px;
  }
  .gear:hover {
    color: var(--text);
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
</style>
