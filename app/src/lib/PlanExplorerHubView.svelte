<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { layoutState, openFileInSplit, switchWorkspaceView } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import {
    buildExplorerTree,
    isUnderRoot,
    newFilePath,
    requestedExplorerPath,
    slugFileName,
    type ExplorerContextNode,
    type ExplorerGroup,
  } from "./planExplorer";
  import PlanTree from "./PlanTree.svelte";
  import FileEditor from "./FileEditor.svelte";
  import PlanMetadataPanel from "./PlanMetadataPanel.svelte";
  import * as backend from "./backend";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let selectedPath = $state<string | null>(null);

  // Deep link from the card detail modal ("Open in Plans tab").
  $effect(() => {
    const p = $requestedExplorerPath;
    if (p) {
      selectedPath = p;
      requestedExplorerPath.set(null);
    }
  });
  let error = $state<string | null>(null);
  let editor = $state<{ flush: () => Promise<void> } | null>(null);

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  const contexts = $derived(buildExplorerTree($gavinTrees[workspaceId]));
  const allPaths = $derived(
    new Set(contexts.flatMap((c) => c.groups.flatMap((g) => g.files.map((f) => f.path))))
  );
  // Selection is held by PATH because the tree rebuilds on every watcher
  // push; a file deleted in a terminal must say so rather than leave a
  // stale buffer on screen.
  const selectionVanished = $derived(selectedPath !== null && !allPaths.has(selectedPath));

  const columnNames = $derived(($kanbanState[workspaceId]?.columns ?? []).map((c) => c.name));
  // The selected file's PlanFileInfo, when it is a plan -- docs and specs
  // have no frontmatter contract, so they get no panel.
  const selectedPlan = $derived.by(() => {
    const tree = $gavinTrees[workspaceId];
    if (!tree || !selectedPath) return null;
    for (const ctx of tree.contexts) {
      const found = ctx.plans.find((p) => p.path === selectedPath);
      if (found) return found;
    }
    return null;
  });

  // The board is needed for the metadata panel's status dropdown;
  // fetchBoard is idempotent, so calling it here means the panel never
  // renders an empty list.
  $effect(() => {
    void fetchBoard(workspaceId);
  });

  // A split needs a terminal session to anchor to; file and board tabs
  // are not sessions.
  const anchorSessionId = $derived.by(() => {
    const focused = $layoutState.focusedSessionId;
    if (!focused) return null;
    if ($layoutState.fileTabsById[focused] || $layoutState.boardTabsById[focused]) return null;
    return focused;
  });

  async function createFile(
    context: ExplorerContextNode,
    group: ExplorerGroup,
    title: string
  ): Promise<void> {
    error = null;
    const fileName = slugFileName(title);
    if (!fileName) {
      error = "That title has no usable filename characters.";
      return;
    }
    try {
      if (group === "plans") {
        // Same daemon path agents use: validated, never overwrites.
        selectedPath = await backend.createPlan(context.folderPath, fileName, title);
      } else {
        const path = newFilePath(context.gavinDir, group, fileName);
        await backend.writeFileForEditor(path, `# ${title}\n`);
        selectedPath = path;
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function createContext(): Promise<void> {
    error = null;
    if (!root) return;
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Folder for the new gavin context",
    });
    if (typeof picked !== "string") return;
    if (!isUnderRoot(root, picked)) {
      error = "Pick a folder inside the workspace root — a context outside it is never scanned.";
      return;
    }
    try {
      await backend.createGavinContext(picked);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function openInSplit(path: string): Promise<void> {
    if (!anchorSessionId) return;
    await switchWorkspaceView(workspaceId, "terminal");
    await openFileInSplit(anchorSessionId, path);
  }
</script>

{#if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else}
  <div class="explorer">
    <div class="sidebar">
      <div class="sidebar-head">
        <span>Contexts</span>
        <button type="button" onclick={createContext} title="Create a .gavin context in a folder">
          + context
        </button>
      </div>
      {#if contexts.length === 0}
        <div class="empty small">No .gavin folders yet — create one to start planning.</div>
      {:else}
        <PlanTree
          {contexts}
          {selectedPath}
          onSelect={(p) => (selectedPath = p)}
          onCreateFile={createFile}
          onOpenInSplit={anchorSessionId ? openInSplit : null}
        />
      {/if}
    </div>
    <div class="detail">
      {#if error}
        <div class="error-strip">
          <span>{error}</span>
          <button type="button" onclick={() => (error = null)}>✕</button>
        </div>
      {/if}
      {#if selectedPath === null}
        <div class="empty">Select a file.</div>
      {:else if selectionVanished}
        <div class="empty">This file no longer exists.</div>
      {:else}
        {#key selectedPath}
          {#if selectedPlan}
            <PlanMetadataPanel
              plan={selectedPlan}
              {workspaceId}
              {columnNames}
              onBeforeWrite={async () => {
                await editor?.flush();
              }}
            />
          {/if}
          <FileEditor bind:this={editor} path={selectedPath} />
        {/key}
      {/if}
    </div>
  </div>
{/if}

<style>
  .explorer {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .sidebar {
    width: 260px;
    flex: 0 0 auto;
    border-right: 1px solid #2f2f2f;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid #2f2f2f;
    color: #999;
    font-family: monospace;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .sidebar-head button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #999;
    font-family: monospace;
    font-size: 1em;
    padding: 1px 6px;
    cursor: pointer;
    text-transform: none;
  }
  .detail {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
    padding: 8px;
    text-align: center;
  }
  .empty.small {
    height: auto;
    padding: 16px 8px;
  }
  .error-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px;
    padding: 6px 10px;
    border: 1px solid #a15c2f;
    border-radius: 6px;
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
    flex: 0 0 auto;
  }
  .error-strip button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    margin-left: auto;
  }
</style>
