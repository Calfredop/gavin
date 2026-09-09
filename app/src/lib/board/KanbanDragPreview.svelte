<script lang="ts">
  import { get } from "svelte/store";
  import { dragState, dropHold, type ActiveDrag } from "$lib/board/kanbanDrag";
  import { activeDragRoot } from "$lib/board/kanbanDragGlue";
  import type { Board, Label } from "$lib/board/kanban";
  import type { CardView } from "$lib/planBoard";
  import BoardCard from "$lib/board/BoardCard.svelte";

  interface Props {
    board: Board | null;
    merged: { columns: { column: { id: string; name: string }; planCards: CardView[] }[]; autoColumns: { status: string; planCards: CardView[] }[] } | null;
    labels: Label[];
    // This surface's board root. dragState/dropHold are app-global, and
    // both surfaces can show the same workspace: only the surface that
    // owns the drag renders the preview, and its settle-target queries
    // stay inside this root.
    root: HTMLElement | null;
  }
  let { board, merged, labels, root }: Props = $props();

  const ownsDrag = $derived(root !== null && $activeDragRoot === root);

  const draggedPlan = $derived<CardView | null>(
    $dragState?.kind === "plan" && merged
      ? ([...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)]
          .flatMap((c) => [c, ...c.nestedChildren])
          .find((p) => p.id === $dragState?.id) ?? null)
      : null
  );
  const draggedColumn = $derived(
    $dragState?.kind === "column" && board ? (board.columns.find((c) => c.id === $dragState?.id) ?? null) : null
  );
  const draggedColumnCount = $derived(
    $dragState?.kind === "column" && merged
      ? (merged.columns.find((dc) => dc.column.id === $dragState?.id)?.planCards.length ?? 0)
      : 0
  );

  function noop(): void {}

  // Drop-settle (spec §6): when the drag ends, the floating preview
  // glides into the card's landed slot (or back home on cancel) and
  // untilts, then the real card takes over. Column drags skip this --
  // the strip's flip animation already covers them.
  interface Settle {
    plan: CardView | null;
    width: number;
    pos: { left: number; top: number };
    landed: boolean;
    // Plan drops hold their visuals until the daemon writes resolve
    // (dropHold); the settled preview sits in the slot until then so the
    // card appears exactly where it settled, never flashing back.
    waitForHold: boolean;
  }
  let settle = $state<Settle | null>(null);
  let snapshot: { drag: ActiveDrag; plan: CardView | null } | null = null;
  // Supersession guard for the async settle steps. A plain counter, NOT
  // an identity check against `settle`: $state proxies objects on
  // assignment, so reading `settle` back never equals the raw object
  // that was assigned -- an identity guard is always true and once left
  // the settle preview stuck on screen after every drop.
  let settleToken = 0;

  $effect(() => {
    if (!ownsDrag) {
      // Another surface took the drag: drop any lingering visuals here.
      snapshot = null;
      settle = null;
      return;
    }
    const d = $dragState;
    if (d) {
      snapshot = { drag: d, plan: draggedPlan };
      settleToken += 1; // a new drag supersedes any in-flight settle
      settle = null;
      return;
    }
    const s = snapshot;
    snapshot = null;
    if (!s || s.drag.kind === "column" || !s.plan) return;
    const started: Settle = {
      plan: s.plan,
      width: s.drag.size.width,
      pos: { left: s.drag.pointer.x - s.drag.grabOffset.x, top: s.drag.pointer.y - s.drag.grabOffset.y },
      landed: false,
      waitForHold: s.drag.kind === "plan",
    };
    const token = (settleToken += 1);
    settle = started;
    // Wait a frame for the committed board to render, then glide to the
    // card's new slot. A plan drop's card is still hidden by dropHold,
    // so its target is the placeholder; a card that can't be found at
    // all (moved out of this filtered view) just drops the preview.
    const scope = root;
    requestAnimationFrame(() => {
      if (settleToken !== token || !scope) return;
      const el =
        scope.querySelector(`[data-kb-plan="${CSS.escape(s.drag.id)}"]`) ?? scope.querySelector("[data-kb-ph]");
      if (!el) {
        settle = null;
        return;
      }
      const r = el.getBoundingClientRect();
      settle = { ...started, pos: { left: r.left, top: r.top }, landed: true };
      setTimeout(() => {
        if (settleToken !== token) return;
        // A plan drop whose writes are still in flight keeps its settled
        // preview; the hold-release effect below clears it.
        if (!settle?.waitForHold || !get(dropHold)) settle = null;
      }, 180);
    });
  });

  // Releases a plan drop's settled preview the moment its writes land
  // (the patch renders the real card in the same flush underneath it).
  $effect(() => {
    if ($dropHold === null && settle?.landed && settle.waitForHold) settle = null;
  });
</script>

{#if ownsDrag && $dragState}
  <div
    class="preview"
    style:left="{$dragState.pointer.x - $dragState.grabOffset.x}px"
    style:top="{$dragState.pointer.y - $dragState.grabOffset.y}px"
    style:width="{$dragState.size.width}px"
  >
    {#if draggedPlan}
      <BoardCard card={draggedPlan} labelDefs={labels} onOpen={noop} />
    {:else if draggedColumn}
      <div class="column-shell">
        <div class="column-title">{draggedColumn.name}</div>
        <div class="column-count">{draggedColumnCount} cards</div>
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
    {#if settle.plan}
      <BoardCard card={settle.plan} labelDefs={labels} onOpen={noop} />
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
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    color: var(--text);
    font-family: monospace;
  }
  .column-title {
    font-weight: bold;
    margin-bottom: 4px;
  }
  .column-count {
    color: var(--text-muted);
    font-size: 0.85em;
  }
</style>
