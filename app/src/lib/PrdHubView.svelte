<script lang="ts">
  import { layoutState } from "./layoutState";
  import FileEditor from "./FileEditor.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  const path = $derived(root ? `${root}/.gavin-root/PRD.md` : null);
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
