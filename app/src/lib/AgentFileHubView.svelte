<script lang="ts">
  import { layoutState } from "./layoutState";
  import FileEditor from "./FileEditor.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  // CLAUDE.md is hardcoded rather than read from config: it is the only
  // agent profile that exists (D4's seam lives in agent_setup.rs's
  // ClaudeCodeProfile), and a lookup for a single value would be
  // speculative.
  const path = $derived(root ? `${root}/CLAUDE.md` : null);
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
