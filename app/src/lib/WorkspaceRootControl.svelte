<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { setWorkspaceRoot } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { agentProfilesStore } from "./layoutState";
  import { resolveAgentConfig } from "./settings";
  import * as backend from "./backend";
  import { UNFILED_WORKSPACE_ID, SMOKETEST_WORKSPACE_ID, type Workspace } from "./workspace";
  import Modal from "./Modal.svelte";

  interface Props {
    workspace: Workspace;
    /// "banner" is the hub-wide strip above every tab; "settings" is the
    /// embedded form row, which drops the banner chrome because the
    /// panel already provides a heading.
    variant?: "banner" | "settings";
  }
  let { workspace, variant = "banner" }: Props = $props();

  // pendingRoot is non-null while the "Initialize gavin here?" modal is up.
  let pendingRoot = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);

  const tree = $derived($gavinTrees[workspace.id]);
  const rootMissing = $derived(Boolean(workspace.rootPath && tree?.rootMissing));
  const agent = $derived(
    resolveAgentConfig(tree?.contexts.find((c) => c.kind === "root")?.agent ?? null, $agentProfilesStore)
  );

  async function pickRoot(): Promise<void> {
    errorMessage = null;
    const picked = await open({ directory: true, multiple: false, title: "Choose workspace root" });
    if (typeof picked !== "string") return;
    if (await backend.gavinRootExists(picked)) {
      await setWorkspaceRoot(workspace.id, picked);
    } else {
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
    await setWorkspaceRoot(workspace.id, root);
  }

  async function bindWithoutInit(): Promise<void> {
    if (!pendingRoot) return;
    const root = pendingRoot;
    pendingRoot = null;
    await setWorkspaceRoot(workspace.id, root);
  }

  // The dev-only Smoke Test workspace's one extra affordance: seed the
  // bound root with the demo fixture set (idempotent -- re-seeding IS the
  // reset). Gated twice: this workspace only, dev builds only (the Rust
  // command additionally refuses outside debug builds).
  const showSeed = $derived(
    workspace.id === SMOKETEST_WORKSPACE_ID && import.meta.env.DEV && Boolean(workspace.rootPath) && !rootMissing
  );
  let seedNote = $state<string | null>(null);

  async function seedDemoData(): Promise<void> {
    if (!workspace.rootPath) return;
    seedNote = null;
    try {
      await backend.seedSmokeTestData(workspace.rootPath);
      seedNote = "Seeded — cards appear within ~3s. Re-click any time to reset the demo files.";
    } catch (e) {
      seedNote = `Couldn't seed: ${e}`;
    }
  }

  // Agent integration (D20): available for every rooted, healthy
  // workspace. Writes are merge-aware and re-runnable (gavin-managed
  // files updated in place; everything else preserved).
  let setupNote = $state<string | null>(null);

  async function setupIntegration(): Promise<void> {
    if (!workspace.rootPath) return;
    setupNote = null;
    try {
      const files = await backend.setupAgentIntegration(workspace.rootPath);
      setupNote = `Wrote: ${files.map((f) => f.replace(workspace.rootPath + "/", "")).join(", ")} — re-run any time to update.`;
    } catch (e) {
      setupNote = `Couldn't set up: ${e}`;
    }
  }
</script>

<div class:settings={variant === "settings"}>
{#if workspace.id !== UNFILED_WORKSPACE_ID}
  {#if !workspace.rootPath}
    <div class="banner">
      <span>No root folder set — bind this workspace to a directory to enable gavin features.</span>
      <button type="button" onclick={pickRoot}>Set root…</button>
    </div>
  {:else if rootMissing}
    <div class="banner warning">
      <span>Root not found: {workspace.rootPath}</span>
      <button type="button" onclick={pickRoot}>Re-pick…</button>
    </div>
  {:else}
    <div class="chip" title={workspace.rootPath}>
      <span class="path">{workspace.rootPath}</span>
      <button type="button" class="gear" onclick={pickRoot} title="Change workspace root">⚙</button>
    </div>
  {/if}
  {#if errorMessage}
    <div class="banner warning"><span>{errorMessage}</span></div>
  {/if}
  {#if showSeed}
    <div class="banner seed">
      <span>Dev smoke test — seed the bound folder with demo plans (auto column, ⚠ card, auth context).</span>
      <button type="button" onclick={seedDemoData}>Seed demo data</button>
    </div>
    {#if seedNote}
      <div class="banner seed"><span>{seedNote}</span></div>
    {/if}
  {/if}
  <!-- Gated on the profile: setup_agent_integration errors for a profile
       with no McpLayout, so offering the button would be a broken action. -->
  {#if workspace.rootPath && !rootMissing && agent.mcpSupported}
    <div class="banner seed">
      <span>Agent integration — write .mcp.json, the gavin skill, and a {agent.file} pointer into this root.</span>
      <button type="button" onclick={setupIntegration}>Set up / update</button>
    </div>
    {#if setupNote}
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
    direction: rtl; /* ellipsis on the LEFT: a path's tail is its informative end */
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
