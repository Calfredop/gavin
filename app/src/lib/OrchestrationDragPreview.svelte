<script lang="ts">
  import { orchDragState } from "./orchestrationDrag";
  import { activeOrchDragRoot } from "./orchestrationDragGlue";
  import type { CardEntry, Orchestration } from "./orchestration";
  import type { Tool } from "./orchestrationTools";

  interface Props {
    orch: Orchestration | null;
    cards: Map<string, CardEntry>;
    /// The tool library, so a tool drag and a tool STEP drag both show a
    /// name rather than a UUID.
    tools: Tool[];
    /// MUST be the very element handed to attachOrchestrationDrag as
    /// `root` -- the ghost renders only for the surface that owns the
    /// drag, and the glue registers that element by identity. Naming it
    /// `dragRoot` rather than `root` because passing the scroll element
    /// instead silently disables the ghost, which is what happened when
    /// the listener moved up to the grid's parent.
    dragRoot: HTMLElement | null;
  }
  let { orch, cards, tools, dragRoot }: Props = $props();

  const ownsDrag = $derived(dragRoot !== null && $activeOrchDragRoot === dragRoot);
  const titleOfPath = (path: string): string =>
    cards.get(path)?.plan.title ?? (path.split("/").pop() ?? "");
  const nameOfTool = (id: string): string => tools.find((t) => t.id === id)?.name ?? id;

  const title = $derived.by(() => {
    const drag = $orchDragState;
    if (!drag) return "";
    // A drawer drag carries the card PATH or the TOOL ID; only a step
    // drag needs the rails walked to find what it points at.
    if (drag.kind === "card") return titleOfPath(drag.id);
    if (drag.kind === "tool") return nameOfTool(drag.id);
    if (!orch) return "";
    for (const rail of orch.rails) {
      for (const stage of rail.stages) {
        for (const step of stage.steps) {
          if (step.id !== drag.id) continue;
          return step.toolId ? nameOfTool(step.toolId) : titleOfPath(step.cardPath);
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
