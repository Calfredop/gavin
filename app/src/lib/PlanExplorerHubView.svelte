<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { layoutState, openFileInSplit, switchWorkspaceView } from "./layoutState";
  import { gavinTrees, refreshGavinTree } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import {
    buildExplorerTree,
    isUnderRoot,
    newFilePath,
    requestedExplorerPath,
    slugFileName,
    type ExplorerContextNode,
    type ExplorerFile,
    type ExplorerGroup,
  } from "./planExplorer";
  import { mergePlanCards, type CardView } from "./planBoard";
  import { deletionPlanFor, executeDeletion, type DeletionPlan } from "./cardDelete";
  import PlanTree from "./PlanTree.svelte";
  import FileEditor from "./FileEditor.svelte";
  import PlanMetadataPanel from "./PlanMetadataPanel.svelte";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import FormatHelpModal from "./FormatHelpModal.svelte";
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
    // Outside contexts sit beyond the watched root, so no push ever
    // confirms this write; a refetch covers both worlds.
    void refreshGavinTree(workspaceId);
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
    try {
      if (isUnderRoot(root, picked)) {
        await backend.createGavinContext(picked);
      } else {
        // Outside the workspace: scaffold AND register it in the root
        // config's extra_contexts so scans list it (shown in orange).
        await backend.addExternalGavinContext(root, picked);
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
    void refreshGavinTree(workspaceId);
  }

  // ---- deletion (files) ----------------------------------------------

  let pendingDelete = $state<ExplorerFile | null>(null);

  // The board projection, for the plan-deletion cascade: nested children
  // die with their plan, free-standing children get un-parented -- same
  // rules as the kanban's delete.
  const allCards = $derived.by<CardView[]>(() => {
    const board = $kanbanState[workspaceId];
    if (!board) return [];
    const merged = mergePlanCards(board, $gavinTrees[workspaceId]);
    return [
      ...merged.columns.flatMap((c) => c.planCards),
      ...merged.autoColumns.flatMap((a) => a.planCards),
    ].flatMap((c) => [c, ...c.nestedChildren]);
  });

  // Null for docs/specs (plain files, no cascade) and when the board
  // hasn't loaded -- then the file deletes alone.
  const pendingDeletePlan = $derived.by<DeletionPlan | null>(() => {
    if (!pendingDelete || pendingDelete.group !== "plans") return null;
    const card = allCards.find((c) => c.id === pendingDelete?.path);
    return card ? deletionPlanFor(card, allCards) : null;
  });

  const pendingDeleteLines = $derived.by(() => {
    if (!pendingDelete) return [];
    const fileName = pendingDelete.path.split("/").at(-1) ?? pendingDelete.path;
    const lines = [`Deletes ${fileName} permanently.`];
    if (pendingDeletePlan) {
      const nested = pendingDeletePlan.files.length - 1;
      if (nested > 0) lines.push(`Also deletes ${nested} nested ${nested === 1 ? "task" : "tasks"}.`);
      const freed = pendingDeletePlan.unparent.length;
      if (freed > 0)
        lines.push(`Un-parents ${freed} free-standing ${freed === 1 ? "child" : "children"} on the board.`);
    }
    return lines;
  });

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    const plan = pendingDeletePlan;
    pendingDelete = null;
    if (!target) return;
    error = null;
    const deleted = plan ? plan.files.map((f) => f.id) : [target.path];
    if (plan) {
      const err = await executeDeletion(workspaceId, plan);
      if (err) error = err;
    } else {
      try {
        await backend.deleteCardFile(target.path);
      } catch (e) {
        error = String(e instanceof Error ? e.message : e);
      }
    }
    if (selectedPath && deleted.includes(selectedPath)) selectedPath = null;
    void refreshGavinTree(workspaceId);
  }

  // ---- outside contexts ----------------------------------------------

  let pendingRemoveOutside = $state<ExplorerContextNode | null>(null);

  async function confirmRemoveOutside(): Promise<void> {
    const target = pendingRemoveOutside;
    pendingRemoveOutside = null;
    if (!target || !root) return;
    error = null;
    try {
      await backend.removeExternalGavinContext(root, target.folderPath);
      if (selectedPath && selectedPath.startsWith(`${target.folderPath}/`)) selectedPath = null;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
    void refreshGavinTree(workspaceId);
  }

  let showFormatHelp = $state(false);

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
        <div class="head-actions">
          <button type="button" onclick={() => (showFormatHelp = true)} title="gavin file formats">
            ?
          </button>
          <button type="button" onclick={createContext} title="Create a .gavin context in a folder">
            + context
          </button>
        </div>
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
          onDeleteFile={(f) => (pendingDelete = f)}
          onRemoveOutside={(c) => (pendingRemoveOutside = c)}
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

{#if pendingDelete}
  <ConfirmPrompt
    title="Delete {pendingDelete.path.split('/').at(-1)}?"
    lines={pendingDeleteLines}
    choices={[{ label: "Delete", danger: true, onPick: confirmDelete }]}
    onCancel={() => (pendingDelete = null)}
  />
{/if}

{#if pendingRemoveOutside}
  <ConfirmPrompt
    title="Remove {pendingRemoveOutside.name} from the navigator?"
    lines={[
      `Stops listing ${pendingRemoveOutside.folderPath} in this workspace.`,
      "No files are deleted — add it again any time with + context.",
    ]}
    choices={[{ label: "Remove", danger: true, onPick: confirmRemoveOutside }]}
    onCancel={() => (pendingRemoveOutside = null)}
  />
{/if}

{#if showFormatHelp}
  <FormatHelpModal onClose={() => (showFormatHelp = false)} />
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
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .head-actions {
    display: flex;
    gap: 4px;
  }
  .sidebar-head button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
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
    color: var(--text-subtle);
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
    border: 1px solid var(--border-warning);
    border-radius: 6px;
    color: var(--warning-text);
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
