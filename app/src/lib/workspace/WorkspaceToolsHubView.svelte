<script lang="ts">
  // The Tools tab: Plans-like editor for agent action prompts and custom
  // tools, with the modal kept for full authoring (params, kinds, groups)
  // and for Duplicate of non-agent built-ins.
  import { Plus, Settings2 } from "@lucide/svelte";
  import { daemonCompat } from "$lib/core/layoutState";
  import { toolRecords, fetchTools, renderLibraryFor } from "$lib/orchestration/toolsState";
  import {
    groupTemplateRecords,
    libraryFor as templateLibraryFor,
    fetchGroupTemplates,
  } from "$lib/orchestration/groupTemplatesState";
  import { refreshToolRuns } from "$lib/orchestration/toolRunsState";
  import { emptyTool, type Tool } from "$lib/orchestration/orchestrationTools";
  import ToolsExplorerView from "$lib/orchestration/ToolsExplorerView.svelte";
  import ToolLibraryDialog from "$lib/orchestration/ToolLibraryDialog.svelte";
  import ToolRunDialog from "$lib/orchestration/ToolRunDialog.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let managing = $state<{ draft: Tool | null } | null>(null);

  $effect(() => {
    const id = workspaceId;
    void fetchTools(id);
    void fetchGroupTemplates(id);
  });

  $effect(() => {
    const id = workspaceId;
    void refreshToolRuns(id, $daemonCompat);
  });

  const library = $derived(renderLibraryFor($toolRecords, workspaceId));
  const templates = $derived(templateLibraryFor($groupTemplateRecords, workspaceId) ?? []);
</script>

<div class="view">
  <header class="bar">
    <p class="lede">
      Edit agent action prompts and tools. Workspace overrides win over app defaults.
    </p>
    <span class="spacer"></span>
    <button
      type="button"
      class="action"
      onclick={() => (managing = { draft: emptyTool(crypto.randomUUID()) })}
    >
      <Plus size={14} /> New tool
    </button>
    <button type="button" class="action" onclick={() => (managing = { draft: null })}>
      <Settings2 size={14} /> Manage library…
    </button>
  </header>

  <div class="explorer-wrap">
    <ToolsExplorerView scope="workspace" {workspaceId} />
  </div>
</div>

<ToolRunDialog />

{#if managing}
  <ToolLibraryDialog
    {workspaceId}
    tools={library}
    {templates}
    initialEdit={managing.draft}
    onClose={() => (managing = null)}
  />
{/if}

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--hub-bar-height);
    box-sizing: border-box;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .lede {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
    max-width: 42rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .action {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .action:hover {
    background: var(--surface-hover);
  }
  .explorer-wrap {
    flex: 1 1 auto;
    min-height: 0;
    padding: 10px 12px 12px;
  }
  .explorer-wrap :global(.explorer) {
    height: 100%;
  }
</style>
