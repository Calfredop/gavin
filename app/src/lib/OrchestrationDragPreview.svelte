<script lang="ts">
  import { orchDragState } from "./orchestrationDrag";
  import { activeOrchDragRoot } from "./orchestrationDragGlue";
  import BoardCard from "./BoardCard.svelte";
  import type { Label } from "./kanban";
  import type { PlacedCardView } from "./planBoard";
  import { findStep, type CardEntry, type Orchestration } from "./orchestration";
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
    /// The board's projection, so a card drag lifts the CARD rather than
    /// a text ghost of its title -- the same thing that lands.
    placedCards: Map<string, PlacedCardView>;
    labelDefs: Label[];
  }
  let { orch, cards, tools, dragRoot, placedCards, labelDefs }: Props = $props();

  const ownsDrag = $derived(dragRoot !== null && $activeOrchDragRoot === dragRoot);
  const titleOfPath = (path: string): string =>
    cards.get(path)?.plan.title ?? (path.split("/").pop() ?? "");
  const nameOfTool = (id: string): string => tools.find((t) => t.id === id)?.name ?? id;

  /// The card path this drag is carrying, or null for a tool (and for a
  /// step whose rail no longer holds it).
  const draggedPath = $derived.by(() => {
    const drag = $orchDragState;
    if (!drag) return null;
    // A drawer drag carries the card PATH or the TOOL ID; only a step
    // drag needs the rails walked to find what it points at.
    if (drag.kind === "card") return drag.id;
    if (drag.kind === "tool") return null;
    const step = orch ? findStep(orch, drag.id) : null;
    return step && !step.toolId ? step.cardPath : null;
  });
  // The full card whenever the board has one for that path; a drawer row
  // being dragged, a deleted card, or a board still loading fall back to
  // the text ghost below.
  const draggedCard = $derived(draggedPath ? (placedCards.get(draggedPath)?.view ?? null) : null);

  const title = $derived.by(() => {
    const drag = $orchDragState;
    if (!drag) return "";
    if (draggedPath) return titleOfPath(draggedPath);
    if (drag.kind === "tool") return nameOfTool(drag.id);
    const step = orch ? findStep(orch, drag.id) : null;
    return step?.toolId ? nameOfTool(step.toolId) : "";
  });

  function noop(): void {}
</script>

{#if ownsDrag && $orchDragState}
  <div
    class="ghost"
    class:card={draggedCard !== null}
    style="left: {$orchDragState.pointer.x - $orchDragState.grabOffset.x}px;
           top: {$orchDragState.pointer.y - $orchDragState.grabOffset.y}px;
           width: {$orchDragState.size.width}px;"
  >
    {#if draggedCard}
      <BoardCard card={draggedCard} {labelDefs} onOpen={noop} />
    {:else}
      {title}
    {/if}
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
  /* A card ghost draws its own box; the chrome above is for the text
     ghost only. The board tilts its preview the same way. */
  .ghost.card {
    padding: 0;
    border: none;
    background: none;
    box-shadow: none;
    overflow: visible;
    white-space: normal;
    transform: rotate(3deg);
    filter: drop-shadow(0 8px 24px rgb(0 0 0 / 0.5));
  }
</style>
