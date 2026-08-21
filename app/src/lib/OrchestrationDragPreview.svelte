<script lang="ts">
  import { orchDragState } from "./orchestrationDrag";
  import { activeOrchDragRoot } from "./orchestrationDragGlue";
  import type { CardEntry, Orchestration } from "./orchestration";

  interface Props {
    orch: Orchestration | null;
    cards: Map<string, CardEntry>;
    /// This surface's grid root. Only the grid that owns the drag renders
    /// the ghost.
    root: HTMLElement | null;
  }
  let { orch, cards, root }: Props = $props();

  const ownsDrag = $derived(root !== null && $activeOrchDragRoot === root);
  const title = $derived.by(() => {
    const id = $orchDragState?.id;
    if (!id || !orch) return "";
    for (const rail of orch.rails) {
      for (const stage of rail.stages) {
        for (const step of stage.steps) {
          if (step.id === id) {
            return cards.get(step.cardPath)?.plan.title ?? (step.cardPath.split("/").pop() ?? "");
          }
        }
      }
    }
    return "";
  });
</script>

{#if ownsDrag && $orchDragState}
  <div
    class="ghost"
    style="left: {$orchDragState.pointer.x - $orchDragState.grabOffset.x}px;
           top: {$orchDragState.pointer.y - $orchDragState.grabOffset.y}px;
           width: {$orchDragState.size.width}px;"
  >
    {title}
  </div>
{/if}

<style>
  .ghost {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    padding: 6px 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-overlay);
    color: var(--text);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.9;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.3);
  }
</style>
