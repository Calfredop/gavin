<script lang="ts">
  import {
    layoutState,
    agentProfilesStore,
    agentModelDefaultsStore,
    setAgentField,
    trustedAgentConfigs,
  } from "$lib/layoutState";
  import { resolveAgentConfig, agentFileFromPick } from "$lib/settings";
  import FileEditor from "$lib/files/FileEditor.svelte";
  import HubFilePicker from "$lib/hub/HubFilePicker.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  // The agent file's name is configurable per workspace (D36): it comes
  // from .gavin-root/config.toml's [agent].file, falling back to the
  // profile's default.
  const agent = $derived(
    resolveAgentConfig(
      $trustedAgentConfigs(workspaceId),
      $agentProfilesStore,
      $agentModelDefaultsStore
    )
  );
  const path = $derived(root ? `${root}/${agent.file}` : null);

  /// Points the workspace at a file it already has. Deliberately NOT the
  /// settings panel's rename flow: that one exists to move gavin's own
  /// file to a new name, and picking an existing CLAUDE.md is the
  /// opposite intent — the file to keep is the one that was picked.
  async function pick(absolutePath: string): Promise<string | null> {
    if (!root) return "No root folder set for this workspace.";
    const result = agentFileFromPick(root, absolutePath);
    if ("error" in result) return result.error;
    if (result.file === agent.file) return null;
    await setAgentField(workspaceId, "file", result.file);
    return null;
  }
</script>

{#if path && root}
  <div class="pane">
    <HubFilePicker
      current={agent.file}
      {root}
      title="Choose the agent instructions file"
      onPick={pick}
    />
    <!-- Keyed: switching workspaces, or repointing at another file, must
         rebuild the editor against the new file rather than leave the
         previous buffer mounted. -->
    {#key path}
      <FileEditor {path} initialMode="edit" layout="document" />
    {/key}
  </div>
{:else}
  <div class="empty">No root folder set for this workspace.</div>
{/if}

<style>
  /* The same column the plan explorer's detail side uses: a fixed strip
     above an editor whose own `height: 100%` makes it want the whole
     column, and whose default flex-shrink then fits it to what is left. */
  .pane {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
  }
</style>
