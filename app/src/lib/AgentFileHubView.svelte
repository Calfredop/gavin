<script lang="ts">
  import { layoutState, agentProfilesStore } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig } from "./settings";
  import FileEditor from "./FileEditor.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  // The agent file's name is configurable per workspace (D36): it comes
  // from .gavin-root/config.toml's [agent].file, falling back to the
  // profile's default.
  const tree = $derived($gavinTrees[workspaceId]);
  const agent = $derived(
    resolveAgentConfig(tree?.contexts.find((c) => c.kind === "root")?.agent ?? null, $agentProfilesStore)
  );
  const path = $derived(root ? `${root}/${agent.file}` : null);
</script>

{#if path}
  <!-- Keyed: switching workspaces must rebuild the editor against the new
       file rather than leave the previous buffer mounted. -->
  {#key path}
    <FileEditor {path} initialMode="edit" />
  {/key}
{:else}
  <div class="empty">No root folder set for this workspace.</div>
{/if}

<style>
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
  }
</style>
