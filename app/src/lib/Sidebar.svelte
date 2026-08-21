<script lang="ts">
  import { accentVar } from "./settings";
  import {
    layoutState,
    switchWorkspace,
    switchWorkspaceView,
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
  import { ChevronRight, ChevronDown, Plus, X, House, Sun, Moon, Monitor, Settings } from "@lucide/svelte";
  import { themeState } from "./ui/themeState.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import type { ThemePref } from "./ui/theme";

  /// System first, matching the default -- and matching the order the
  /// three states read in: follow the OS, or override it either way.
  const THEME_OPTIONS: { pref: ThemePref; label: string; icon: typeof Sun }[] = [
    { pref: "system", label: "Follow system", icon: Monitor },
    { pref: "light", label: "Light", icon: Sun },
    { pref: "dark", label: "Dark", icon: Moon },
  ];
  import { sessionLabel } from "./paths";
  import { HUB_VIEWS } from "./workspaceViews";
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    computeReorderPosition,
    type DropZone,
    type ReorderPosition,
  } from "./dragDrop";
  import { movePaneOrTab, reorderWorkspaceAction, movePageAction, switchToSessionInPage } from "./layoutState";
  import { UNFILED_WORKSPACE_ID, summarizePageGitStatus, getActiveView, sidebarWorkspaceOrder, type Workspace, type Page, type GitStatus } from "./workspace";
  import { hintMode } from "./shortcutHints";
  import { hintDigitFor } from "./shortcuts";
  import ShortcutHint from "./ui/ShortcutHint.svelte";
  import { message } from "@tauri-apps/plugin-dialog";
  import { openContextMenuFromEvent } from "./contextMenu";
  import {
    buildWorkspaceMenuEntries,
    buildPageMenuEntries,
    buildSessionRowMenuEntries,
    type SidebarMenuHooks,
  } from "./sidebarMenu";

  let expanded: Set<string> = $state(new Set());

  // Tracks which pages currently have their multi-repo git detail
  // expanded -- unrelated to `expanded` above (that Set tracks which
  // WORKSPACES show their page list; this one tracks which PAGES show
  // their per-session git detail). Kept separate rather than reusing one
  // Set, since workspace ids and page ids are different concepts that
  // happen to both be strings.
  let expandedPagesGit: Set<string> = $state(new Set());

  function isPageGitExpanded(pageId: string): boolean {
    return expandedPagesGit.has(pageId);
  }

  function togglePageGitExpand(pageId: string): void {
    const next = new Set(expandedPagesGit);
    if (next.has(pageId)) {
      next.delete(pageId);
    } else {
      next.add(pageId);
    }
    expandedPagesGit = next;
  }

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

  // ⌘⌥-number addresses workspaces in the order this sidebar renders
  // them (Unfiled pinned first) -- the same helper the router uses, so a
  // badge and its shortcut can never point at different rows.
  const orderedWorkspaces = $derived(sidebarWorkspaceOrder($layoutState.workspaces));

  /// ⌘⇧-number switches pages, and only within the ACTIVE workspace --
  /// badging another workspace's pages would promise a jump that
  /// shortcut does not make.
  function pageHint(ws: Workspace, index: number): string | null {
    if ($hintMode !== "cmd-shift" || ws.id !== $layoutState.activeWorkspaceId) return null;
    const digit = hintDigitFor(index, ws.pages.length);
    return digit === null ? null : String(digit);
  }

  function workspaceHint(workspaceId: string): string | null {
    if ($hintMode !== "cmd-alt") return null;
    const index = orderedWorkspaces.findIndex((w) => w.id === workspaceId);
    const digit = index === -1 ? null : hintDigitFor(index, orderedWorkspaces.length);
    return digit === null ? null : String(digit);
  }

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

  function pageGitSummary(page: Page) {
    return summarizePageGitStatus(page, $layoutState.gitStatusById);
  }

  // ahead/behind are only meaningful (and only shown) when hasUpstream is
  // true, and only the non-zero side(s) are shown -- "main" alone when
  // fully up to date with its upstream, "main ↑2" when only ahead,
  // "main ↑2 ↓1" when diverged. Not extracted to workspace.ts: this is
  // presentational string formatting, not branching business logic (see
  // this plan's Global Constraints on what needed its own pure-function
  // test), matching this file's existing local-helper precedent
  // (waitingForInputCount and friends are template-local too).
  function formatAheadBehind(status: GitStatus): string {
    if (!status.hasUpstream) return "";
    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`↑${status.ahead}`);
    if (status.behind > 0) parts.push(`↓${status.behind}`);
    return parts.join(" ");
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

  function reportMenuError(text: string): void {
    console.error(text);
    void message(text, { title: "gavin", kind: "error" });
  }

  function menuHooks(): SidebarMenuHooks {
    return {
      startRenameWorkspace: (id) => {
        const w = $layoutState.workspaces.find((x) => x.id === id);
        if (w) startEditingWorkspace(w.id, w.name);
      },
      startRenamePage: (id) => {
        const p = $layoutState.workspaces.flatMap((w) => w.pages).find((x) => x.id === id);
        if (p) startEditingPage(p.id, p.name);
      },
      newPage: quickAddPage,
      reportError: reportMenuError,
    };
  }

  // Inside an inline rename input the native text menu must keep working.
  function inTextInput(e: MouseEvent): boolean {
    return e.target instanceof HTMLInputElement;
  }

  function openWorkspaceMenu(e: MouseEvent, ws: Workspace): void {
    if (inTextInput(e)) return;
    openContextMenuFromEvent(e, buildWorkspaceMenuEntries(ws, menuHooks()));
  }

  function openPageMenu(e: MouseEvent, ws: Workspace, page: Page): void {
    if (inTextInput(e)) return;
    openContextMenuFromEvent(e, buildPageMenuEntries(ws, page, $layoutState.workspaces, menuHooks()));
  }

  function openSessionRowMenu(e: MouseEvent, ws: Workspace, page: Page, sessionId: string): void {
    const cwd = $layoutState.cwdBySessionId[sessionId] ?? null;
    openContextMenuFromEvent(e, buildSessionRowMenuEntries(ws, page, sessionId, cwd, menuHooks()));
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

{#snippet pageList(ws: Workspace, showHomeRow: boolean)}
  <div class="page-list">
    {#if showHomeRow}
      <div
        class="page-row home"
        class:active={ws.id === $layoutState.activeWorkspaceId && getActiveView(ws) !== "terminal"}
        onclick={() => {
          switchWorkspace(ws.id);
          switchWorkspaceView(ws.id, HUB_VIEWS[0].id);
        }}
        role="button"
        tabindex="0"
        title="Hub"
      >
        <House size={14} />
      </div>
    {/if}
    {#each ws.pages as page, pageIndex (page.id)}
      {@const gitSummary = pageGitSummary(page)}
      <div class="page-row-group">
        <div
          class="page-row"
          class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId && getActiveView(ws) === "terminal"}
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
          oncontextmenu={(e) => openPageMenu(e, ws, page)}
        >
          {#if gitSummary.kind === "multiple"}
            <IconButton
              icon={isPageGitExpanded(page.id) ? ChevronDown : ChevronRight}
              label={isPageGitExpanded(page.id) ? "Collapse git detail" : "Expand git detail"}
              size={10}
              onclick={() => togglePageGitExpand(page.id)}
            />
          {/if}
          {#if $hintMode === "cmd-shift"}
            {@const hint = pageHint(ws, pageIndex)}
            {#if hint}<ShortcutHint text={hint} />{/if}
          {/if}
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
              onclick={() => {
                switchWorkspaceView(ws.id, "terminal");
                switchPage(ws.id, page.id);
              }}
            >{page.name}</span>
          {/if}
          {#if gitSummary.kind === "single"}
            <span class="git-branch">{gitSummary.status.branch}</span>
            <span
              class="git-dot"
              class:dirty={gitSummary.status.dirty}
              class:clean={!gitSummary.status.dirty}
            ></span>
            {#if formatAheadBehind(gitSummary.status)}
              <span class="git-ahead-behind">{formatAheadBehind(gitSummary.status)}</span>
            {/if}
          {:else if gitSummary.kind === "multiple"}
            <!-- Always plural: summarizePageGitStatus only returns "multiple"
                 when the distinct repo count is 2 or more. -->
            <span class="git-repo-count">{gitSummary.repoCount} repos</span>
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
        {#if gitSummary.kind === "multiple" && isPageGitExpanded(page.id)}
          <div class="page-git-detail">
            {#each allSessionIds(page.layout) as sessionId (sessionId)}
              {@const sessionStatus = $layoutState.gitStatusById[sessionId]}
              <div
                class="git-session-row"
                onclick={() => {
                  switchWorkspaceView(ws.id, "terminal");
                  switchToSessionInPage(ws.id, page.id, sessionId);
                }}
                oncontextmenu={(e) => openSessionRowMenu(e, ws, page, sessionId)}
              >
                <span class="git-session-label">
                  {sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId)}
                </span>
                {#if sessionStatus}
                  <span class="git-branch">{sessionStatus.branch}</span>
                  <span
                    class="git-dot"
                    class:dirty={sessionStatus.dirty}
                    class:clean={!sessionStatus.dirty}
                  ></span>
                  {#if formatAheadBehind(sessionStatus)}
                    <span class="git-ahead-behind">{formatAheadBehind(sessionStatus)}</span>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/snippet}

<div class="sidebar">
  <div class="sidebar-header">
    <span>Workspaces</span>
    <IconButton icon={Plus} label="New Workspace" size={14} onclick={startCreatingWorkspace} />
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
          style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
          class:active={ws.id === $layoutState.activeWorkspaceId}
          class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
          ondragover={(e) => handleWorkspaceDragOver(e, ws.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handleWorkspaceDrop(e, ws)}
          oncontextmenu={(e) => openWorkspaceMenu(e, ws)}
        >
          <IconButton
            icon={isExpanded(ws.id) ? ChevronDown : ChevronRight}
            label={isExpanded(ws.id) ? "Collapse" : "Expand"}
            size={12}
            onclick={() => toggleExpand(ws.id)}
          />
          {#if $hintMode === "cmd-alt"}
            {@const hint = workspaceHint(ws.id)}
            {#if hint}<ShortcutHint text={hint} />{/if}
          {/if}
          <span class="workspace-name" onclick={() => switchWorkspace(ws.id)}>{ws.name}</span>
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
          {/if}
          <IconButton icon={Plus} label="New Page" size={12} onclick={() => quickAddPage(ws.id)} />
        </div>
        {#if isExpanded(ws.id)}
          {@render pageList(ws, false)}
        {/if}
      </div>
    {/if}
    {#each regularWorkspaces as ws (ws.id)}
      <div class="workspace-row-group">
        <div
          class="workspace-row"
          style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
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
          oncontextmenu={(e) => openWorkspaceMenu(e, ws)}
        >
          <IconButton
            icon={isExpanded(ws.id) ? ChevronDown : ChevronRight}
            label={isExpanded(ws.id) ? "Collapse" : "Expand"}
            size={12}
            onclick={() => toggleExpand(ws.id)}
          />
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
            {#if $hintMode === "cmd-alt"}
              {@const hint = workspaceHint(ws.id)}
              {#if hint}<ShortcutHint text={hint} />{/if}
            {/if}
            <span
              class="workspace-name"
              ondblclick={() => startEditingWorkspace(ws.id, ws.name)}
              onclick={() => switchWorkspace(ws.id)}
            >{ws.name}</span>
          {/if}
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
          {/if}
          <IconButton icon={Plus} label="New Page" size={12} onclick={() => quickAddPage(ws.id)} />
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
          {@render pageList(ws, true)}
        {/if}
      </div>
    {/each}
  </div>
  <div class="sidebar-footer">
    <button class="footer-row" disabled title="Coming soon">
      <Settings size={12} />
      <span>Settings</span>
    </button>
    <div class="footer-row theme-row">
      <span>Theme</span>
      <div class="theme-toggle">
        {#each THEME_OPTIONS as opt (opt.pref)}
          <IconButton
            icon={opt.icon}
            label={opt.label}
            variant="segmented"
            size={12}
            active={themeState.pref === opt.pref}
            onclick={() => void themeState.setPref(opt.pref)}
          />
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .sidebar {
    width: 200px;
    flex: 0 0 auto;
    background: var(--surface-raised);
    color: var(--text);
    font-family: monospace;
    font-size: 0.8em;
    display: flex;
    flex-direction: column;
    /* The scroll lives on .workspace-list, not here: a footer on a
       scrolling sidebar would slide away with the content. Pinning it
       pins the header too, which it wasn't before. */
    overflow: hidden;
    border-right: 1px solid var(--border);
  }
  .workspace-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .sidebar-header {
    /* Pinned now that .sidebar no longer scrolls -- without this it can
       shrink when the workspace list is long. */
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    font-weight: bold;
    color: var(--text-muted);
  }
  .sidebar-header button {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
  }
  .new-workspace-input,
  .workspace-name-input,
  .page-name-input {
    background: var(--surface-sunken);
    color: var(--text);
    border: 1px solid var(--border-focus);
    border-radius: 3px;
    font-family: monospace;
    font-size: 1em;
    padding: 2px 4px;
    margin: 0 8px 4px 8px;
    width: calc(100% - 16px);
    box-sizing: border-box;
  }
  .workspace-row {
    /* Anchors the hold-⌘ hint badge. */
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    /* padding-left drops by the stripe's width so the row's contents do
       not shift when a colour is set. */
    padding: 4px 8px 4px 5px;
    /* Its own variable, always set: --ws-accent is inherited from the
       active workspace's container, which would paint every row. */
    border-left: 3px solid var(--row-accent, transparent);
    cursor: pointer;
  }
  .workspace-row.active {
    background: var(--surface-raised);
  }
  .workspace-row.pinned {
    font-style: italic;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    margin-bottom: 2px;
  }
  .workspace-row.pinned.active {
    color: var(--text);
  }
  .workspace-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .waiting-badge {
    flex: 0 0 auto;
    background: var(--danger);
    color: var(--text-inverted);
    border-radius: 8px;
    padding: 0 5px;
    font-size: 0.85em;
    line-height: 1.4;
    min-width: 14px;
    text-align: center;
  }
  .git-branch {
    flex: 0 1 auto;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .git-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
    box-sizing: border-box;
  }
  .git-dot.dirty {
    background: var(--warning);
  }
  .git-dot.clean {
    background: transparent;
    border: 1px solid var(--warning);
  }
  .git-ahead-behind {
    flex: 0 1 auto;
    overflow: hidden;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .git-repo-count {
    flex: 0 1 auto;
    overflow: hidden;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .close-workspace,
  .close-page {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    opacity: 0.6;
    flex: 0 0 auto;
  }
  .close-workspace:hover,
  .close-page:hover {
    opacity: 1;
  }
  .page-list {
    display: flex;
    flex-direction: column;
  }
  .page-row {
    /* Anchors the hold-⌘ hint badge, which overlays the row rather than
       reflowing (and re-truncating) its name. */
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px 3px 28px;
    cursor: pointer;
  }
  .page-row.active {
    background: var(--surface-base);
    color: var(--text);
  }
  .page-row.home {
    justify-content: center;
    color: var(--text-muted);
  }
  .page-row.home.active {
    color: var(--text);
  }
  .workspace-row.drop-before,
  .page-row.drop-before {
    box-shadow: inset 0 2px 0 0 var(--accent);
  }
  .workspace-row.drop-after,
  .page-row.drop-after {
    box-shadow: inset 0 -2px 0 0 var(--accent);
  }
  .workspace-row.drop-append {
    background: var(--surface-selected);
  }
  .page-row.drop-zone-left {
    box-shadow: inset 2px 0 0 0 var(--accent);
  }
  .page-row.drop-zone-right {
    box-shadow: inset -2px 0 0 0 var(--accent);
  }
  .page-row.drop-zone-top {
    box-shadow: inset 0 2px 0 0 var(--accent);
  }
  .page-row.drop-zone-bottom {
    box-shadow: inset 0 -2px 0 0 var(--accent);
  }
  .page-row.drop-zone-center {
    background: var(--surface-selected);
  }
  .page-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-git-detail {
    display: flex;
    flex-direction: column;
  }
  .git-session-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px 2px 44px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .git-session-row:hover {
    background: var(--surface-base);
  }
  .git-session-label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .sidebar-footer {
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
    padding: 4px 0;
  }
  .footer-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: inherit;
    text-align: left;
  }
  button.footer-row {
    cursor: pointer;
  }
  button.footer-row:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  button.footer-row:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .theme-row {
    justify-content: space-between;
  }
  .theme-toggle {
    display: flex;
    gap: 2px;
    /* One inset well holding all three, so the active segment reads as a
       selection rather than three unrelated buttons. */
    background: var(--surface-sunken);
    border-radius: 4px;
    padding: 1px;
  }
</style>
