<script lang="ts">
  import { layoutState, createPage } from "./layoutState";
  import { presetSingle } from "./layout";
  import LayoutTree from "./LayoutTree.svelte";

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
    color: #eee;
    font-family: monospace;
    height: 100%;
  }
  .overlay button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #3a3a3a;
    border: none;
    color: #eee;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
