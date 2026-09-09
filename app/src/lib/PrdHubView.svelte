<script lang="ts">
  import { layoutState, daemonCompat, setPrdPath } from "$lib/layoutState";
  import { gavinTrees } from "$lib/gavinState";
  import { featureBlockedReason } from "$lib/daemonCompat";
  import { resolvePrdPath, prdPathFromPick } from "$lib/settings";
  import FileEditor from "$lib/FileEditor.svelte";
  import HubFilePicker from "$lib/hub/HubFilePicker.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  // Which file leads this workspace is configurable: a project that
  // already had a PRD points `prd` at it rather than keeping a second one
  // under .gavin-root/. Absent means the scaffolded default.
  const tree = $derived($gavinTrees[workspaceId]);
  const relative = $derived(resolvePrdPath(tree?.contexts.find((c) => c.kind === "root")));
  const path = $derived(root ? `${root}/${relative}` : null);
  const blocked = $derived(featureBlockedReason($daemonCompat, "prdPath"));

  async function pick(absolutePath: string): Promise<string | null> {
    if (!root) return "No root folder set for this workspace.";
    const result = prdPathFromPick(root, absolutePath);
    if ("error" in result) return result.error;
    await setPrdPath(workspaceId, result.path);
    return null;
  }
</script>

{#if path && root}
  <div class="pane">
    <HubFilePicker
      current={relative}
      {root}
      title="Choose the PRD file"
      blockedReason={blocked}
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
