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
  import { folderName } from "./paths";

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

  export function fitAll(): void {
    for (const id of leaf.tabs) {
      paneRefs[id]?.fit();
    }
  }

  function tabLabel(sessionId: string): string {
    const customName = $layoutState.sessionNames[sessionId];
    if (customName) return customName;
    const cwd = $layoutState.cwdBySessionId[sessionId];
    return cwd ? folderName(cwd) : sessionId.slice(0, 8);
  }

  function tabTooltip(sessionId: string): string {
    return $layoutState.sessionNames[sessionId] ?? $layoutState.cwdBySessionId[sessionId] ?? sessionId;
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
  <div class="tab-bar">
    {#each leaf.tabs as sessionId (sessionId)}
      <button class="tab" class:active={sessionId === active} onclick={() => switchToTab(sessionId)}>
        {#if sessionId === active && isFocused}
          <span class="focus-dot"></span>
        {/if}
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
  <div class="content" bind:this={containerEl} onmousedown={() => focusPane(active)}>
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
    border: none;
    color: #aaa;
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
  }
  .tab.active {
    background: #1e1e1e;
    color: #fff;
  }
  .focus-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4a9eff;
    flex: 0 0 auto;
  }
  .tab-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    color: #aaa;
    cursor: pointer;
    padding: 4px 8px;
  }
  .content {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
  }
</style>
