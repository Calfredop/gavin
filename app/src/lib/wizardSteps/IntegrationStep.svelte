<script lang="ts">
  import {
    agentModelDefaultsStore,
    agentProfilesStore,
    layoutState,
    recordMcpForeignChoice,
    trustedAgentConfigs,
  } from "$lib/core/layoutState";
  import { resolveAgentConfig } from "$lib/core/settings";
  import * as backend from "$lib/core/backend";
  import { foreignMcpServersHash, runIntegration } from "$lib/workspace/mcpServerTrust";
  import McpForeignChooser from "$lib/workspace/McpForeignChooser.svelte";

  interface Props {
    workspaceId: string;
    onDone: () => void;
    /// When set, integration writes this instructions file instead of
    /// the workspace's currently resolved one. The agent-change wizard
    /// passes the PENDING profile's file so MCP/skills land for the
    /// agent being switched to, even before the tree watcher catches up.
    instructionsFile?: string;
    /// Arm THIS profile's MCP config rather than the workspace's active
    /// agent. Fallback arming sets it so Integration cannot rewrite the
    /// workspace profile.
    profileId?: string;
  }
  let { workspaceId, onDone, instructionsFile, profileId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  // The file gavin's marker block goes into. Through the same resolution
  // every other panel uses, so an unapproved `[agent] file` cannot make
  // this step write somewhere the Settings panel does not name.
  const agentFile = $derived(
    instructionsFile ??
      resolveAgentConfig($trustedAgentConfigs(workspaceId), $agentProfilesStore, $agentModelDefaultsStore)
        .file
  );

  let result = $state<backend.IntegrationResult | null>(null);
  let error = $state<string | null>(null);
  let running = $state(false);
  // Set instead of `result` when the target MCP config names servers
  // gavin did not add and no recorded choice answers this exact set
  // (AG-07) -- the run pauses here until the human picks.
  let pendingForeign = $state<backend.McpForeignServers | null>(null);

  async function run(): Promise<void> {
    if (!ws?.rootPath) return;
    running = true;
    error = null;
    pendingForeign = null;
    try {
      const r = await runIntegration(ws.rootPath, agentFile, ws.mcpForeignServersChoice, profileId);
      if (r.mcpForeign) {
        pendingForeign = r.mcpForeign;
      } else {
        result = r;
      }
    } catch (e) {
      error = String(e);
    }
    running = false;
  }

  async function chooseMcp(action: "keep" | "isolate"): Promise<void> {
    if (!pendingForeign || !ws?.rootPath) return;
    running = true;
    try {
      await recordMcpForeignChoice(workspaceId, {
        hash: foreignMcpServersHash(pendingForeign.servers),
        action,
      });
      result = await backend.setupAgentIntegration(ws.rootPath, agentFile, action, profileId);
      pendingForeign = null;
    } catch (e) {
      error = String(e);
    }
    running = false;
  }

  function short(path: string): string {
    return ws?.rootPath ? path.replace(ws.rootPath + "/", "") : path;
  }
</script>

<h3>Integration files</h3>
<p class="hint">
  Teaches your agent about this workspace. Safe to re-run — hand-written content outside gavin's
  markers is never touched.
</p>

{#if pendingForeign}
  <McpForeignChooser
    servers={pendingForeign.servers}
    isolateRefusal={pendingForeign.isolateRefusal}
    busy={running}
    onKeep={() => void chooseMcp("keep")}
    onIsolate={() => void chooseMcp("isolate")}
  />
{:else if result}
  <ul class="results">
    {#each result.written as path (path)}
      <li class="ok">✓ {short(path)}</li>
    {/each}
    <!-- Its own line, and its own colour: this is the only row that says
         a file gavin overwrote was not gavin's to begin with. Naming the
         kept copy is the point -- without it the human learns nothing
         they could act on. -->
    {#each result.replaced as [file, backup] (file)}
      <li class="replaced">⟳ {short(file)} — your copy kept as {short(backup)}</li>
    {/each}
    {#each result.skipped as [what, why] (what)}
      <li class="skip">— {what}: {why}</li>
    {/each}
  </ul>
{:else if error}
  <p class="warn">{error}</p>
{/if}

<div class="actions">
  {#if result}
    <button type="button" onclick={onDone}>Continue →</button>
  {:else if !pendingForeign}
    <button type="button" disabled={running} onclick={() => void run()}>
      {running ? "Writing…" : "Set up integration"}
    </button>
  {/if}
</div>

<style>
  h3 {
    margin: 0 0 4px;
    font-size: 0.95em;
    font-family: monospace;
    color: #eee;
  }
  .hint {
    margin: 0 0 16px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: monospace;
    font-size: 0.8em;
  }
  .results li {
    margin-bottom: 6px;
  }
  .ok {
    color: #8bc98b;
  }
  /* Amber, not green and not grey: the run succeeded, and something of
     the workspace's own was displaced doing it. */
  .replaced {
    color: #e0b08a;
  }
  .skip {
    color: #888;
  }
  .warn {
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 18px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
