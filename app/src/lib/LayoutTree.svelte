<script lang="ts">
  import { onDestroy } from "svelte";
  import type { LayoutNode } from "./layout";
  import Pane from "./Pane.svelte";
  import { previewResizePane, commitLayout } from "./layoutState";

  let { node, path }: { node: LayoutNode; path: number[] } = $props();

  let container: HTMLDivElement;
  let dragIndex = $state<number | null>(null);

  function startDrag(index: number, event: PointerEvent): void {
    if (node.type !== "split") return;
    dragIndex = index;
    event.preventDefault();
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", stopDrag);
  }

  function onDrag(event: PointerEvent): void {
    if (node.type !== "split" || dragIndex === null || !container) return;
    const rect = container.getBoundingClientRect();
    const isRow = node.direction === "row";
    const total = isRow ? rect.width : rect.height;
    const offset = isRow ? event.clientX - rect.left : event.clientY - rect.top;
    const fraction = Math.min(0.9, Math.max(0.1, offset / total));

    const sizes = [...node.sizes];
    const before = sizes.slice(0, dragIndex).reduce((a, b) => a + b, 0);
    const remaining = sizes[dragIndex] + sizes[dragIndex + 1];
    const newFirst = Math.min(remaining - 0.05, Math.max(0.05, fraction - before));
    sizes[dragIndex] = newFirst;
    sizes[dragIndex + 1] = remaining - newFirst;
    previewResizePane(path, sizes);
  }

  function stopDrag(): void {
    dragIndex = null;
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", stopDrag);
    void commitLayout();
  }

  onDestroy(() => {
    stopDrag();
  });
</script>

{#if node.type === "leaf"}
  <Pane leaf={node} />
{:else}
  <div
    class="split"
    class:row={node.direction === "row"}
    class:column={node.direction === "column"}
    bind:this={container}
  >
    {#each node.children as child, index (index)}
      <div class="child" style="flex-grow: {node.sizes[index]}">
        <svelte:self node={child} path={[...path, index]} />
      </div>
      {#if index < node.children.length - 1}
        <div
          class="divider"
          class:row={node.direction === "row"}
          class:column={node.direction === "column"}
          onpointerdown={(e) => startDrag(index, e)}
        ></div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .split {
    display: flex;
    width: 100%;
    height: 100%;
  }
  .split.row {
    flex-direction: row;
  }
  .split.column {
    flex-direction: column;
  }
  .child {
    position: relative;
    overflow: hidden;
  }
  .divider {
    flex: 0 0 4px;
    background: var(--surface-overlay);
  }
  .divider.row {
    cursor: col-resize;
  }
  .divider.column {
    cursor: row-resize;
  }
</style>
