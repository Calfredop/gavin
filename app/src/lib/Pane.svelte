<script lang="ts">
  import { onMount } from "svelte";
  import type { LayoutNode } from "./layout";
  import TerminalPane from "./TerminalPane.svelte";
  import {
    layoutState,
    switchToTab,
    addTab,
    closeSession,
    focusPane,
    setSessionName,
  } from "./layoutState";
  import { confirmTabClose } from "./confirmClose";
  import { X, Plus } from "@lucide/svelte";
  import Tooltip from "./Tooltip.svelte";
  import { sessionLabel } from "./paths";
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    type DropZone,
  } from "./dragDrop";
  import { movePaneOrTab, reorderTabWithinPane } from "./layoutState";
  import { getActiveWorkspace, getActivePage } from "./workspace";

  let { leaf }: { leaf: Extract<LayoutNode, { type: "leaf" }> } = $props();

  let paneRefs: Record<string, { fit: () => void }> = {};
  let containerEl: HTMLDivElement;

  const isFocused = $derived(
    $layoutState.focusedSessionId !== null && leaf.tabs.includes($layoutState.focusedSessionId)
  );
  const active = $derived(leaf.tabs[leaf.activeTabIndex]);

  // $state, not plain `let` -- editInput is a bind:this target read inside
  // the $effect below, and only $state reads establish reactivity there
  // (see the tabLabel/onMount comment above for the same lesson applied to
  // containerEl, which deliberately does NOT need this because its consumer
  // is onMount, not an $effect).
  let editingSessionId: string | null = $state(null);
  let editValue = $state("");
  let editInput: HTMLInputElement | null = $state(null);

  // Hover feedback for the two different drop surfaces this pane offers:
  // contentDropZone for the 5-zone overlay on .content (grafting from
  // elsewhere, cross-page or same-page), tabReorderState for the
  // before/after insertion indicator when dragging a tab across this
  // pane's own tab-bar.
  let contentDropZone: DropZone | null = $state(null);
  let tabReorderState: { sessionId: string; position: "before" | "after" } | null = $state(null);

  export function fitAll(): void {
    for (const id of leaf.tabs) {
      paneRefs[id]?.fit();
    }
  }

  function tabLabel(sessionId: string): string {
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }

  function tabTooltip(sessionId: string): string {
    return $layoutState.sessionNames[sessionId] ?? $layoutState.cwdBySessionId[sessionId] ?? sessionId;
  }

  // idle intentionally returns null here -- no dot at all is the idle
  // indicator, not a neutral-colored one (see this plan's Global
  // Constraints). waiting_for_input is "request attention" in the UI --
  // the internal/data-model name stays unchanged, matching the existing
  // Rust enum.
  function tabStatusDot(sessionId: string): { class: string; title: string } | null {
    const status = $layoutState.sessionStatusById[sessionId];
    if (status === "working") return { class: "status-working", title: "Working" };
    if (status === "waiting_for_input") return { class: "status-waiting", title: "Request attention" };
    return null;
  }

  // Filled when dirty, hollow (outlined) when clean, absent entirely when
  // this session has no git repo -- no branch name, no ahead/behind, and
  // no tooltip here; that detail lives entirely in the sidebar (see this
  // plan's Global Constraints).
  function tabGitDot(sessionId: string): { dirty: boolean } | null {
    const status = $layoutState.gitStatusById[sessionId];
    if (!status) return null;
    return { dirty: status.dirty };
  }

  function startEditing(sessionId: string): void {
    editingSessionId = sessionId;
    editValue = tabLabel(sessionId);
  }

  function commitEdit(): void {
    if (editingSessionId === null) return;
    void setSessionName(editingSessionId, editValue);
    editingSessionId = null;
  }

  function cancelEdit(): void {
    editingSessionId = null;
  }

  function activeLocation(): { workspaceId: string; pageId: string } | null {
    const ws = getActiveWorkspace($layoutState);
    const page = getActivePage($layoutState);
    if (!ws || !page) return null;
    return { workspaceId: ws.id, pageId: page.id };
  }

  function handlePaneDragStart(event: DragEvent): void {
    const location = activeLocation();
    if (!location) return;
    setDragPayload(event, { kind: "pane", workspaceId: location.workspaceId, pageId: location.pageId, sessionId: active });
  }

  function handleTabDragStart(event: DragEvent, sessionId: string): void {
    // Prevents this event from also triggering the parent .tab-bar's own
    // dragstart handler via bubbling -- see this task's module-level note
    // on why that would silently turn a single-tab drag into a
    // whole-pane drag.
    event.stopPropagation();
    const location = activeLocation();
    if (!location) return;
    setDragPayload(event, { kind: "tab", workspaceId: location.workspaceId, pageId: location.pageId, sessionId });
  }

  function handleTabDragOver(event: DragEvent, sessionId: string): void {
    if (getDragKind(event) !== "tab") return;
    event.preventDefault();
    event.stopPropagation();
    // Without an explicit dropEffect, the browser shows the "copy" (+)
    // cursor even though setDragPayload set effectAllowed to "move" --
    // dropEffect has to be set on the target's dragover, not just
    // effectAllowed on the source's dragstart.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    tabReorderState = { sessionId, position: x < 0.5 ? "before" : "after" };
  }

  function clearTabReorder(): void {
    tabReorderState = null;
  }

  async function handleTabDrop(event: DragEvent, sessionId: string, index: number): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const payload = getDragPayload(event);
    tabReorderState = null;
    if (!payload || payload.kind !== "tab") return;
    const location = activeLocation();
    if (!location) return;
    if (
      leaf.tabs.includes(payload.sessionId) &&
      payload.workspaceId === location.workspaceId &&
      payload.pageId === location.pageId
    ) {
      // Reordering within this same pane's own tab bar.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const targetIndex = x < 0.5 ? index : index + 1;
      await reorderTabWithinPane(payload.sessionId, targetIndex);
    } else {
      // A tab from elsewhere, dropped onto a specific tab in this pane --
      // merge it in as a new tab here, same as dropping on .content's
      // center zone. targetSessionId: active pins the merge to THIS
      // pane specifically, not wherever the page's remembered focus
      // happens to point.
      await movePaneOrTab(
        { kind: "tab", workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "page", workspaceId: location.workspaceId, pageId: location.pageId, mode: "center", targetSessionId: active }
      );
    }
  }

  function handleContentDragOver(event: DragEvent): void {
    const kind = getDragKind(event);
    if (kind !== "pane" && kind !== "tab") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = containerEl.getBoundingClientRect();
    contentDropZone = computeDropZone(rect, event.clientX, event.clientY);
  }

  function clearContentDrop(): void {
    contentDropZone = null;
  }

  async function handleContentDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearContentDrop();
    if (!payload || (payload.kind !== "pane" && payload.kind !== "tab")) return;
    const location = activeLocation();
    if (!location) return;
    const rect = containerEl.getBoundingClientRect();
    const zone = computeDropZone(rect, event.clientX, event.clientY);
    await movePaneOrTab(
      { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
      { kind: "page", workspaceId: location.workspaceId, pageId: location.pageId, mode: zone, targetSessionId: active }
    );
  }

  $effect(() => {
    if (editingSessionId !== null && editInput) {
      editInput.focus();
      editInput.select();
    }
  });

  // onMount, not a $effect gated on containerEl -- containerEl is a plain
  // `let` (bind:this target), so reading it inside $effect would never
  // establish reactivity and the observer would never actually get set up.
  // Svelte guarantees bind:this refs are already populated by the time
  // onMount runs, and this div is never conditionally recreated, so a
  // one-time setup here is both correct and simpler than chasing reactivity.
  onMount(() => {
    const observer = new ResizeObserver(() => fitAll());
    observer.observe(containerEl);
    return () => observer.disconnect();
  });
</script>

<div class="pane-wrapper">
  <div class="tab-bar" draggable={editingSessionId === null} ondragstart={handlePaneDragStart}>
    {#each leaf.tabs as sessionId, tabIndex (sessionId)}
      <button
        class="tab"
        class:active={sessionId === active}
        class:focused={sessionId === active && isFocused}
        class:drop-before={tabReorderState?.sessionId === sessionId && tabReorderState.position === "before"}
        class:drop-after={tabReorderState?.sessionId === sessionId && tabReorderState.position === "after"}
        draggable={editingSessionId !== sessionId}
        ondragstart={(e) => handleTabDragStart(e, sessionId)}
        ondragover={(e) => handleTabDragOver(e, sessionId)}
        ondragleave={clearTabReorder}
        ondragend={clearTabReorder}
        ondrop={(e) => handleTabDrop(e, sessionId, tabIndex)}
        onclick={() => switchToTab(sessionId)}
      >
        {#if editingSessionId === sessionId}
          <input
            class="tab-label-input"
            bind:this={editInput}
            bind:value={editValue}
            onclick={(e) => e.stopPropagation()}
            onblur={commitEdit}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
          />
        {:else}
          <Tooltip text={tabTooltip(sessionId)}>
            <span class="tab-label" ondblclick={() => startEditing(sessionId)}>{tabLabel(sessionId)}</span>
          </Tooltip>
        {/if}
        {#if tabStatusDot(sessionId)}
          {@const dot = tabStatusDot(sessionId)}
          <span class="status-dot {dot?.class}" title={dot?.title}></span>
        {/if}
        {#if tabGitDot(sessionId)}
          {@const gitDot = tabGitDot(sessionId)}
          <span
            class="git-dot"
            class:dirty={gitDot?.dirty}
            class:clean={!gitDot?.dirty}
            title={gitDot?.dirty ? "Uncommitted changes" : "Clean"}
          ></span>
        {/if}
        <span
          class="close"
          aria-label="Close Tab"
          title="Close Tab"
          onclick={async (e) => {
            e.stopPropagation();
            if (await confirmTabClose(sessionId)) {
              closeSession(sessionId);
            }
          }}
        >
          <X size={12} />
        </span>
      </button>
    {/each}
    <button class="new-tab" aria-label="New Tab" title="New Tab" onclick={() => addTab(active)}>
      <Plus size={14} />
    </button>
  </div>
  <div
    class="content"
    class:drop-zone-left={contentDropZone === "left"}
    class:drop-zone-right={contentDropZone === "right"}
    class:drop-zone-top={contentDropZone === "top"}
    class:drop-zone-bottom={contentDropZone === "bottom"}
    class:drop-zone-center={contentDropZone === "center"}
    bind:this={containerEl}
    onmousedown={() => focusPane(active)}
    ondragover={handleContentDragOver}
    ondragleave={clearContentDrop}
    ondragend={clearContentDrop}
    ondrop={handleContentDrop}
  >
    {#each leaf.tabs as sessionId (sessionId)}
      <TerminalPane
        bind:this={paneRefs[sessionId]}
        {sessionId}
        visible={sessionId === active}
        focused={sessionId === $layoutState.focusedSessionId}
      />
    {/each}
  </div>
</div>

<style>
  .pane-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }
  .tab-bar {
    display: flex;
    background: #2a2a2a;
    flex: 0 0 auto;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    /* border-top is always present (transparent when inactive) so toggling
       the indicator on/off never changes the tab's box height -- box-sizing
       keeps that same 2px folded into the height in both states. */
    border: none;
    border-top: 2px solid transparent;
    box-sizing: border-box;
    color: #aaa;
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
  }
  .tab.active {
    background: #1e1e1e;
    color: #fff;
  }
  .tab.focused {
    border-top-color: #4a9eff;
  }
  .tab.drop-before {
    box-shadow: inset 2px 0 0 0 #4a9eff;
  }
  .tab.drop-after {
    box-shadow: inset -2px 0 0 0 #4a9eff;
  }
  .tab-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .status-dot.status-working {
    background: #4a9eff;
  }
  .status-dot.status-waiting {
    background: #e0524a;
  }
  .git-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
    box-sizing: border-box;
  }
  .git-dot.dirty {
    background: #d9a648;
  }
  .git-dot.clean {
    background: transparent;
    border: 1px solid #d9a648;
  }
  .tab-label-input {
    max-width: 120px;
    width: 100px;
    background: #111;
    color: #fff;
    border: 1px solid #4a9eff;
    border-radius: 3px;
    font-family: monospace;
    font-size: 1em;
    padding: 0 2px;
  }
  .close {
    opacity: 0.6;
  }
  .close:hover {
    opacity: 1;
  }
  .new-tab {
    background: transparent;
    border: none;
    border-top: 2px solid transparent;
    box-sizing: border-box;
    color: #aaa;
    cursor: pointer;
    padding: 4px 8px;
  }
  .content {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
  }
  .content.drop-zone-left::after,
  .content.drop-zone-right::after,
  .content.drop-zone-top::after,
  .content.drop-zone-bottom::after,
  .content.drop-zone-center::after {
    content: "";
    position: absolute;
    background: rgba(74, 158, 255, 0.35);
    pointer-events: none;
    z-index: 2;
  }
  .content.drop-zone-left::after {
    inset: 0 75% 0 0;
  }
  .content.drop-zone-right::after {
    inset: 0 0 0 75%;
  }
  .content.drop-zone-top::after {
    inset: 0 0 75% 0;
  }
  .content.drop-zone-bottom::after {
    inset: 75% 0 0 0;
  }
  .content.drop-zone-center::after {
    inset: 25%;
  }
</style>
