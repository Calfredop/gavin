<script lang="ts">
  import {
    layoutState,
    switchWorkspace,
    switchPage,
    createWorkspace,
    renameWorkspace,
    createPage,
    renamePage,
    closeWorkspace,
    closePage,
  } from "./layoutState";
  import { confirmWorkspaceClose, confirmPageClose } from "./confirmClose";
  import { presetSingle } from "./layout";
  import { ChevronRight, ChevronDown, Plus, X } from "@lucide/svelte";

  let expanded: Set<string> = $state(new Set());

  let creatingWorkspace = $state(false);
  let newWorkspaceName = $state("");
  let newWorkspaceInput: HTMLInputElement | null = $state(null);

  let editingWorkspaceId: string | null = $state(null);
  let workspaceEditValue = $state("");
  let workspaceEditInput: HTMLInputElement | null = $state(null);

  let editingPageId: string | null = $state(null);
  let pageEditValue = $state("");
  let pageEditInput: HTMLInputElement | null = $state(null);

  function isExpanded(workspaceId: string): boolean {
    return expanded.has(workspaceId);
  }

  function toggleExpand(workspaceId: string): void {
    const next = new Set(expanded);
    if (next.has(workspaceId)) {
      next.delete(workspaceId);
    } else {
      next.add(workspaceId);
    }
    expanded = next;
  }

  function startCreatingWorkspace(): void {
    creatingWorkspace = true;
    newWorkspaceName = "";
  }

  function commitNewWorkspace(): void {
    if (!creatingWorkspace) return;
    const trimmed = newWorkspaceName.trim();
    creatingWorkspace = false;
    if (trimmed) void createWorkspace(trimmed);
  }

  function cancelNewWorkspace(): void {
    creatingWorkspace = false;
  }

  function startEditingWorkspace(workspaceId: string, currentName: string): void {
    editingWorkspaceId = workspaceId;
    workspaceEditValue = currentName;
  }

  function commitWorkspaceEdit(): void {
    if (editingWorkspaceId === null) return;
    const trimmed = workspaceEditValue.trim();
    const id = editingWorkspaceId;
    editingWorkspaceId = null;
    if (trimmed) void renameWorkspace(id, trimmed);
  }

  function cancelWorkspaceEdit(): void {
    editingWorkspaceId = null;
  }

  function startEditingPage(pageId: string, currentName: string): void {
    editingPageId = pageId;
    pageEditValue = currentName;
  }

  function commitPageEdit(): void {
    if (editingPageId === null) return;
    const trimmed = pageEditValue.trim();
    const id = editingPageId;
    editingPageId = null;
    if (!trimmed) return;
    const ws = $layoutState.workspaces.find((w) => w.pages.some((p) => p.id === id));
    if (!ws) return;
    void renamePage(ws.id, id, trimmed);
  }

  function cancelPageEdit(): void {
    editingPageId = null;
  }

  function quickAddPage(workspaceId: string): void {
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    void createPage(workspaceId, ([id]) => presetSingle(id), 1, `Page ${ws.pages.length + 1}`);
  }

  $effect(() => {
    const activeId = $layoutState.activeWorkspaceId;
    if (activeId && !expanded.has(activeId)) {
      expanded = new Set(expanded).add(activeId);
    }
  });

  $effect(() => {
    if (creatingWorkspace && newWorkspaceInput) {
      newWorkspaceInput.focus();
    }
  });

  $effect(() => {
    if (editingWorkspaceId !== null && workspaceEditInput) {
      workspaceEditInput.focus();
      workspaceEditInput.select();
    }
  });

  $effect(() => {
    if (editingPageId !== null && pageEditInput) {
      pageEditInput.focus();
      pageEditInput.select();
    }
  });
</script>

<div class="sidebar">
  <div class="sidebar-header">
    <span>Workspaces</span>
    <button aria-label="New Workspace" title="New Workspace" onclick={startCreatingWorkspace}>
      <Plus size={14} />
    </button>
  </div>
  {#if creatingWorkspace}
    <input
      class="new-workspace-input"
      bind:this={newWorkspaceInput}
      bind:value={newWorkspaceName}
      onblur={commitNewWorkspace}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitNewWorkspace();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelNewWorkspace();
        }
      }}
    />
  {/if}
  <div class="workspace-list">
    {#each $layoutState.workspaces as ws (ws.id)}
      <div class="workspace-row-group">
        <div class="workspace-row" class:active={ws.id === $layoutState.activeWorkspaceId}>
          <button
            class="expand-toggle"
            aria-label={isExpanded(ws.id) ? "Collapse" : "Expand"}
            onclick={() => toggleExpand(ws.id)}
          >
            {#if isExpanded(ws.id)}
              <ChevronDown size={12} />
            {:else}
              <ChevronRight size={12} />
            {/if}
          </button>
          {#if editingWorkspaceId === ws.id}
            <input
              class="workspace-name-input"
              bind:this={workspaceEditInput}
              bind:value={workspaceEditValue}
              onclick={(e) => e.stopPropagation()}
              onblur={commitWorkspaceEdit}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitWorkspaceEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelWorkspaceEdit();
                }
              }}
            />
          {:else}
            <span
              class="workspace-name"
              ondblclick={() => startEditingWorkspace(ws.id, ws.name)}
              onclick={() => switchWorkspace(ws.id)}
            >{ws.name}</span>
          {/if}
          <button class="add-page" aria-label="New Page" title="New Page" onclick={() => quickAddPage(ws.id)}>
            <Plus size={12} />
          </button>
          <button
            class="close-workspace"
            aria-label="Close Workspace"
            title="Close Workspace"
            onclick={async () => {
              if (await confirmWorkspaceClose(ws.id)) {
                void closeWorkspace(ws.id);
              }
            }}
          >
            <X size={12} />
          </button>
        </div>
        {#if isExpanded(ws.id)}
          <div class="page-list">
            {#each ws.pages as page (page.id)}
              <div class="page-row" class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId}>
                {#if editingPageId === page.id}
                  <input
                    class="page-name-input"
                    bind:this={pageEditInput}
                    bind:value={pageEditValue}
                    onclick={(e) => e.stopPropagation()}
                    onblur={commitPageEdit}
                    onkeydown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitPageEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelPageEdit();
                      }
                    }}
                  />
                {:else}
                  <span
                    class="page-name"
                    ondblclick={() => startEditingPage(page.id, page.name)}
                    onclick={() => switchPage(ws.id, page.id)}
                  >{page.name}</span>
                {/if}
                <button
                  class="close-page"
                  aria-label="Close Page"
                  title="Close Page"
                  onclick={async () => {
                    if (await confirmPageClose(ws.id, page.id)) {
                      void closePage(ws.id, page.id);
                    }
                  }}
                >
                  <X size={10} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .sidebar {
    width: 200px;
    flex: 0 0 auto;
    background: #232323;
    color: #ccc;
    font-family: monospace;
    font-size: 0.8em;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    border-right: 1px solid #1a1a1a;
  }
  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    font-weight: bold;
    color: #999;
  }
  .sidebar-header button {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    padding: 2px;
  }
  .new-workspace-input,
  .workspace-name-input,
  .page-name-input {
    background: #111;
    color: #fff;
    border: 1px solid #4a9eff;
    border-radius: 3px;
    font-family: monospace;
    font-size: 1em;
    padding: 2px 4px;
    margin: 0 8px 4px 8px;
    width: calc(100% - 16px);
    box-sizing: border-box;
  }
  .workspace-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    cursor: pointer;
  }
  .workspace-row.active {
    background: #2a2a2a;
  }
  .expand-toggle {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    padding: 0;
    display: flex;
  }
  .workspace-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-page,
  .close-workspace,
  .close-page {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    padding: 2px;
    opacity: 0.6;
    flex: 0 0 auto;
  }
  .add-page:hover,
  .close-workspace:hover,
  .close-page:hover {
    opacity: 1;
  }
  .page-list {
    display: flex;
    flex-direction: column;
  }
  .page-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px 3px 28px;
    cursor: pointer;
  }
  .page-row.active {
    background: #1e1e1e;
    color: #fff;
  }
  .page-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
