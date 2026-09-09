<script lang="ts">
  import { orchDragState } from "$lib/orchestrationDrag";
  import { activeOrchDragRoot } from "$lib/orchestrationDragGlue";
  import BoardCard from "$lib/board/BoardCard.svelte";
  import type { Label } from "$lib/board/kanban";
  import type { PlacedCardView } from "$lib/planBoard";
  import { findStep, stageLabelById, type CardEntry, type Orchestration } from "$lib/orchestration";
  import type { Tool } from "$lib/orchestrationTools";
  import type { GroupTemplate } from "$lib/orchestrationGroups";

  interface Props {
    orch: Orchestration | null;
    cards: Map<string, CardEntry>;
    /// The tool library, so a tool drag and a tool STEP drag both show a
    /// name rather than a UUID.
    tools: Tool[];
    /// The group template library, so dragging a template row off the
    /// drawer shows its name instead of an empty ghost -- the same
    /// reason `tools` is here for a tool row.
    templates: GroupTemplate[];
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
  let { orch, cards, tools, templates, dragRoot, placedCards, labelDefs }: Props = $props();

  const ownsDrag = $derived(dragRoot !== null && $activeOrchDragRoot === dragRoot);
  const titleOfPath = (path: string): string =>
    cards.get(path)?.plan.title ?? (path.split("/").pop() ?? "");
  const nameOfTool = (id: string): string => tools.find((t) => t.id === id)?.name ?? id;
  const nameOfTemplate = (id: string): string => templates.find((t) => t.id === id)?.name ?? id;
  // Exactly the label the group's own header is showing -- its name, or
  // the positional "stage N" -- because a ghost that reads "Group" says
  // nothing about WHICH group is in flight, which is the one thing a
  // human dragging one past three others needs to know. stageLabelById
  // numbers over the rail's position order; that is the rendered order
  // during a group drag, since only a STEP drag collapses a stage out of
  // the list. "Group" survives as the last resort for a stage that left
  // the orchestration mid-drag, where there is no label to show.
  const nameOfStage = (id: string): string =>
    (orch ? stageLabelById(orch, id) : null) ?? "Group";

  /// The card path this drag is carrying, or null for a tool, a
  /// template, a whole group (and for a step whose rail no longer holds
  /// it).
  const draggedPath = $derived.by(() => {
    const drag = $orchDragState;
    if (!drag) return null;
    // A drawer drag carries the card PATH, the TOOL id or the TEMPLATE
    // id; a whole-group drag carries a STAGE id. None of those are a
    // step id, so only a step drag needs the rails walked to find what
    // it points at.
    if (drag.kind === "card") return drag.id;
    if (drag.kind === "tool" || drag.kind === "template" || drag.kind === "stage") return null;
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
    if (drag.kind === "template") return nameOfTemplate(drag.id);
    if (drag.kind === "stage") return nameOfStage(drag.id);
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
