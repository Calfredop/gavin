<script lang="ts">
  import { dragState, type ActiveDrag } from "./kanbanDrag";
  import type { Board, Card, Label } from "./kanban";
  import type { PlanCardView } from "./planBoard";
  import KanbanCard from "./KanbanCard.svelte";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";

  interface Props {
    board: Board | null;
    merged: { columns: { column: { id: string; name: string }; planCards: PlanCardView[] }[]; autoColumns: { status: string; planCards: PlanCardView[] }[] } | null;
    labels: Label[];
  }
  let { board, merged, labels }: Props = $props();

  const draggedCard = $derived<Card | null>(
    $dragState?.kind === "card" && board
      ? (board.columns.flatMap((c) => c.cards).find((c) => c.id === $dragState?.id) ?? null)
      : null
  );
  const draggedPlan = $derived<PlanCardView | null>(
    $dragState?.kind === "plan" && merged
      ? ([...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].find(
          (p) => p.id === $dragState?.id
        ) ?? null)
      : null
  );
  const draggedColumn = $derived(
    $dragState?.kind === "column" && board ? (board.columns.find((c) => c.id === $dragState?.id) ?? null) : null
  );

  function noop(): void {}

  // Drop-settle (spec §6): when the drag ends, the floating preview
  // glides into the card's landed slot (or back home on cancel) and
  // untilts, then the real card takes over. Column drags skip this --
  // the strip's flip animation already covers them.
  interface Settle {
    card: Card | null;
    plan: PlanCardView | null;
    width: number;
    pos: { left: number; top: number };
    landed: boolean;
  }
  let settle = $state<Settle | null>(null);
  let snapshot: { drag: ActiveDrag; card: Card | null; plan: PlanCardView | null } | null = null;

  $effect(() => {
    const d = $dragState;
    if (d) {
      snapshot = { drag: d, card: draggedCard, plan: draggedPlan };
      return;
    }
    const s = snapshot;
    snapshot = null;
    if (!s || s.drag.kind === "column" || (!s.card && !s.plan)) return;
    const started: Settle = {
      card: s.card,
      plan: s.plan,
      width: s.drag.size.width,
      pos: { left: s.drag.pointer.x - s.drag.grabOffset.x, top: s.drag.pointer.y - s.drag.grabOffset.y },
      landed: false,
    };
    settle = started;
    // Wait a frame for the committed board to render, then glide to the
    // card's new slot; if it can't be found (moved out of this filtered
    // view), just drop the preview.
    requestAnimationFrame(() => {
      if (settle !== started) return;
      const attr = s.drag.kind === "card" ? "data-kb-card" : "data-kb-plan";
      const el = document.querySelector(`[${attr}="${CSS.escape(s.drag.id)}"]`);
      if (!el) {
        settle = null;
        return;
      }
      const r = el.getBoundingClientRect();
      settle = { ...started, pos: { left: r.left, top: r.top }, landed: true };
      setTimeout(() => {
        if (settle?.landed) settle = null;
      }, 180);
    });
  });
</script>

{#if $dragState}
  <div
    class="preview"
    style:left="{$dragState.pointer.x - $dragState.grabOffset.x}px"
    style:top="{$dragState.pointer.y - $dragState.grabOffset.y}px"
    style:width="{$dragState.size.width}px"
  >
    {#if draggedCard}
      <KanbanCard card={draggedCard} {labels} onOpen={noop} onDelete={noop} />
    {:else if draggedPlan}
      <PlanKanbanCard plan={draggedPlan} onOpen={noop} />
    {:else if draggedColumn}
      <div class="column-shell">
        <div class="column-title">{draggedColumn.name}</div>
        <div class="column-count">{draggedColumn.cards.length} cards</div>
      </div>
    {/if}
  </div>
{:else if settle}
  <div
    class="preview settling"
    class:landed={settle.landed}
    style:left="{settle.pos.left}px"
    style:top="{settle.pos.top}px"
    style:width="{settle.width}px"
  >
    {#if settle.card}
      <KanbanCard card={settle.card} {labels} onOpen={noop} onDelete={noop} />
    {:else if settle.plan}
      <PlanKanbanCard plan={settle.plan} onOpen={noop} />
    {/if}
  </div>
{/if}

<style>
  .preview {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    transform: rotate(3deg);
    filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.5));
  }
  .preview.settling {
    transition: left 140ms ease, top 140ms ease, transform 140ms ease, filter 140ms ease;
  }
  .preview.settling.landed {
    transform: rotate(0deg);
    filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.3));
  }
  .column-shell {
    background: #232323;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 10px;
    color: #eee;
    font-family: monospace;
  }
  .column-title {
    font-weight: bold;
    margin-bottom: 4px;
  }
  .column-count {
    color: #999;
    font-size: 0.85em;
  }
</style>
