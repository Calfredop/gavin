<script lang="ts">
  import { layoutState, createPage } from "$lib/layoutState";
  import { presetSingle } from "$lib/panes/layout";
  import LayoutTree from "$lib/panes/LayoutTree.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const activeTree = $derived(ws ? (ws.pages.find((p) => p.id === ws.activePageId)?.layout ?? null) : null);

  async function addPage(): Promise<void> {
    if (!ws) return;
    await createPage(ws.id, ([id]) => presetSingle(id), 1, `Page ${ws.pages.length + 1}`);
  }
</script>

{#if !activeTree}
  <div class="overlay">
    <button onclick={addPage}>New Page</button>
  </div>
{:else}
  <div class="tree">
    <LayoutTree node={activeTree} path={[]} />
  </div>
{/if}

<style>
  .tree {
    width: 100%;
    height: 100%;
    position: relative;
  }
  .overlay {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text);
    font-family: monospace;
    height: 100%;
  }
  .overlay button {
    margin-top: 12px;
    padding: 8px 16px;
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
