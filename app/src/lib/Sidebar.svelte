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
  import { presetSingle, allSessionIds } from "./layout";
  import { ChevronRight, ChevronDown, Plus, X } from "@lucide/svelte";
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    computeReorderPosition,
    type DropZone,
    type ReorderPosition,
  } from "./dragDrop";
  import { movePaneOrTab, reorderWorkspaceAction, movePageAction } from "./layoutState";
  import { UNFILED_WORKSPACE_ID, type Workspace, type Page } from "./workspace";

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

  // Tracks which row is currently being hovered during a drag, and how --
  // recomputed fresh on every dragover, so a stale highlight left behind
  // by an imperfect dragleave (a well-known HTML5 DnD fragility -- it
  // fires when the pointer crosses a CHILD element's boundary too, not
  // just when truly leaving the row) gets corrected the moment the
  // pointer moves onto whatever row is actually now under it. Cleared
  // unconditionally on dragend/drop so nothing lingers after the
  // operation completes.
  type HoverState =
    | { targetId: string; kind: "reorder"; position: ReorderPosition }
    | { targetId: string; kind: "zone"; zone: DropZone }
    | { targetId: string; kind: "append" };
  let hoverState: HoverState | null = $state(null);

  function clearHover(): void {
    hoverState = null;
  }

  // The pinned Unfiled workspace is always rendered first, separately
  // from the reorderable list -- these two derived values split
  // $layoutState.workspaces accordingly. unfiledWorkspace is null only
  // before bootstrap's first workspaces-ready/poll response arrives
  // (the Rust side always creates it once ready).
  const unfiledWorkspace = $derived($layoutState.workspaces.find((w) => w.id === UNFILED_WORKSPACE_ID) ?? null);
  const regularWorkspaces = $derived($layoutState.workspaces.filter((w) => w.id !== UNFILED_WORKSPACE_ID));

  // The count this plan's sidebar badges show -- waiting_for_input only,
  // never a generic aggregate across all three states (see this plan's
  // Global Constraints: "working" is background information, not
  // something a badge needs to draw the eye to).
  function waitingForInputCount(page: Page): number {
    return allSessionIds(page.layout).filter((id) => $layoutState.sessionStatusById[id] === "waiting_for_input").length;
  }

  function workspaceWaitingForInputCount(ws: Workspace): number {
    return ws.pages.reduce((sum, page) => sum + waitingForInputCount(page), 0);
  }

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

  function handleWorkspaceDragStart(event: DragEvent, workspaceId: string): void {
    setDragPayload(event, { kind: "workspace", workspaceId });
  }

  function handleWorkspaceDragOver(event: DragEvent, workspaceId: string): void {
    const kind = getDragKind(event);
    if (!kind) return;
    // The pinned Unfiled workspace isn't part of the reorderable list, so
    // a dragged workspace has nowhere meaningful to land on it -- ignore.
    if (kind === "workspace" && workspaceId === UNFILED_WORKSPACE_ID) return;
    event.preventDefault();
    // Without an explicit dropEffect, the browser shows the "copy" (+)
    // cursor even though setDragPayload set effectAllowed to "move" --
    // dropEffect has to be set on the target's dragover, not just
    // effectAllowed on the source's dragstart.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (kind === "workspace" || kind === "page") {
      hoverState = { targetId: workspaceId, kind: "reorder", position: computeReorderPosition(rect, event.clientY) };
    } else {
      hoverState = { targetId: workspaceId, kind: "append" };
    }
  }

  async function handleWorkspaceDrop(event: DragEvent, ws: Workspace): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearHover();
    if (!payload) return;
    if (payload.kind === "workspace") {
      if (ws.id === UNFILED_WORKSPACE_ID) return;
      // Looked up live from the authoritative array (not a loop index
      // passed in) so this is correct regardless of whether the pinned
      // Unfiled workspace occupies a slot ahead of this row or not.
      // Simple index/index+1 relative to the currently rendered array --
      // an approximation (dragging past an immediate neighbor can land
      // one position off in edge cases, since reorderWorkspace removes
      // the moved item before re-inserting, which can shift indices).
      // Acceptable for a first cut of a manually-tested drag interaction;
      // refine later if it feels wrong in practice.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const position = computeReorderPosition(rect, event.clientY);
      const currentIndex = $layoutState.workspaces.findIndex((w) => w.id === ws.id);
      const targetIndex = position === "before" ? currentIndex : currentIndex + 1;
      await reorderWorkspaceAction(payload.workspaceId, targetIndex);
    } else if (payload.kind === "page") {
      await movePageAction(payload.pageId, ws.id, ws.pages.length);
    } else {
      await movePaneOrTab(
        { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "workspace", workspaceId: ws.id }
      );
    }
  }

  function handlePageDragStart(event: DragEvent, workspaceId: string, pageId: string): void {
    setDragPayload(event, { kind: "page", workspaceId, pageId });
  }

  function handlePageDragOver(event: DragEvent, pageId: string): void {
    const kind = getDragKind(event);
    if (!kind || kind === "workspace") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (kind === "page") {
      hoverState = { targetId: pageId, kind: "reorder", position: computeReorderPosition(rect, event.clientY) };
    } else {
      hoverState = { targetId: pageId, kind: "zone", zone: computeDropZone(rect, event.clientX, event.clientY) };
    }
  }

  async function handlePageDrop(event: DragEvent, ws: Workspace, page: Page, index: number): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearHover();
    if (!payload || payload.kind === "workspace") return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (payload.kind === "page") {
      const position = computeReorderPosition(rect, event.clientY);
      const targetIndex = position === "before" ? index : index + 1;
      await movePageAction(payload.pageId, ws.id, targetIndex);
    } else {
      const zone = computeDropZone(rect, event.clientX, event.clientY);
      await movePaneOrTab(
        { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "page", workspaceId: ws.id, pageId: page.id, mode: zone }
      );
    }
  }

  // Auto-expands a workspace the first time it becomes active, without
  // fighting a later manual collapse. Gating on activeId actually
  // *changing* (via lastSyncedActiveId, a plain closure var -- it's
  // effect-internal bookkeeping, not rendered, so it doesn't need $state)
  // means `expanded` is only read when activeId itself just changed, not
  // on every run this effect happens to see -- reading `expanded` inside
  // an effect that also writes it otherwise re-triggers itself and
  // silently reverts the very collapse it just observed.
  let lastSyncedActiveId: string | null = null;
  $effect(() => {
    const activeId = $layoutState.activeWorkspaceId;
    if (activeId && activeId !== lastSyncedActiveId) {
      lastSyncedActiveId = activeId;
      if (!expanded.has(activeId)) {
        expanded = new Set(expanded).add(activeId);
      }
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

{#snippet pageList(ws: Workspace)}
  <div class="page-list">
    {#each ws.pages as page, pageIndex (page.id)}
      <div
        class="page-row"
        class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId}
        class:drop-before={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "before"}
        class:drop-after={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "after"}
        class:drop-zone-left={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "left"}
        class:drop-zone-right={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "right"}
        class:drop-zone-top={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "top"}
        class:drop-zone-bottom={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "bottom"}
        class:drop-zone-center={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "center"}
        draggable={editingPageId !== page.id}
        ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
        ondragover={(e) => handlePageDragOver(e, page.id)}
        ondragleave={clearHover}
        ondragend={clearHover}
        ondrop={(e) => handlePageDrop(e, ws, page, pageIndex)}
      >
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
        {#if waitingForInputCount(page) > 0}
          <span class="waiting-badge">{waitingForInputCount(page)}</span>
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
{/snippet}

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
    {#if unfiledWorkspace}
      {@const ws = unfiledWorkspace}
      <div class="workspace-row-group">
        <div
          class="workspace-row pinned"
          class:active={ws.id === $layoutState.activeWorkspaceId}
          class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
          ondragover={(e) => handleWorkspaceDragOver(e, ws.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handleWorkspaceDrop(e, ws)}
        >
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
          <span class="workspace-name" onclick={() => switchWorkspace(ws.id)}>{ws.name}</span>
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
          {/if}
          <button class="add-page" aria-label="New Page" title="New Page" onclick={() => quickAddPage(ws.id)}>
            <Plus size={12} />
          </button>
        </div>
        {#if isExpanded(ws.id)}
          {@render pageList(ws)}
        {/if}
      </div>
    {/if}
    {#each regularWorkspaces as ws (ws.id)}
      <div class="workspace-row-group">
        <div
          class="workspace-row"
          class:active={ws.id === $layoutState.activeWorkspaceId}
          class:drop-before={hoverState?.targetId === ws.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "before"}
          class:drop-after={hoverState?.targetId === ws.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "after"}
          class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
          draggable={editingWorkspaceId !== ws.id}
          ondragstart={(e) => handleWorkspaceDragStart(e, ws.id)}
          ondragover={(e) => handleWorkspaceDragOver(e, ws.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handleWorkspaceDrop(e, ws)}
        >
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
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
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
          {@render pageList(ws)}
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
  .workspace-row.pinned {
    font-style: italic;
    color: #999;
    border-bottom: 1px solid #333;
    margin-bottom: 2px;
  }
  .workspace-row.pinned.active {
    color: #ccc;
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
  .waiting-badge {
    flex: 0 0 auto;
    background: #e0524a;
    color: #fff;
    border-radius: 8px;
    padding: 0 5px;
    font-size: 0.85em;
    line-height: 1.4;
    min-width: 14px;
    text-align: center;
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
  .workspace-row.drop-before,
  .page-row.drop-before {
    box-shadow: inset 0 2px 0 0 #4a9eff;
  }
  .workspace-row.drop-after,
  .page-row.drop-after {
    box-shadow: inset 0 -2px 0 0 #4a9eff;
  }
  .workspace-row.drop-append {
    background: #2d4a6a;
  }
  .page-row.drop-zone-left {
    box-shadow: inset 2px 0 0 0 #4a9eff;
  }
  .page-row.drop-zone-right {
    box-shadow: inset -2px 0 0 0 #4a9eff;
  }
  .page-row.drop-zone-top {
    box-shadow: inset 0 2px 0 0 #4a9eff;
  }
  .page-row.drop-zone-bottom {
    box-shadow: inset 0 -2px 0 0 #4a9eff;
  }
  .page-row.drop-zone-center {
    background: #2d4a6a;
  }
  .page-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
