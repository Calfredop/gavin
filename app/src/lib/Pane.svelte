<script lang="ts">
  import { onMount } from "svelte";
  import type { LayoutNode } from "./layout";
  import TerminalPane from "./TerminalPane.svelte";
  import { layoutState, switchToTab, addTab, closeSession, focusPane } from "./layoutState";
  import { confirmTabClose } from "./confirmClose";
  import { X, Plus } from "@lucide/svelte";

  let { leaf }: { leaf: Extract<LayoutNode, { type: "leaf" }> } = $props();

  let paneRefs: Record<string, { fit: () => void }> = {};
  let containerEl: HTMLDivElement;

  const isFocused = $derived(
    $layoutState.focusedSessionId !== null && leaf.tabs.includes($layoutState.focusedSessionId)
  );
  const active = $derived(leaf.tabs[leaf.activeTabIndex]);

  export function fitAll(): void {
    for (const id of leaf.tabs) {
      paneRefs[id]?.fit();
    }
  }

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

<div class="pane-wrapper" class:focused={isFocused}>
  <div class="tab-bar">
    {#each leaf.tabs as sessionId (sessionId)}
      <button class="tab" class:active={sessionId === active} onclick={() => switchToTab(sessionId)}>
        {sessionId.slice(0, 8)}
        <span
          class="close"
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
    border: 1px solid transparent;
    box-sizing: border-box;
  }
  .pane-wrapper.focused {
    border-color: #4a9eff;
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
