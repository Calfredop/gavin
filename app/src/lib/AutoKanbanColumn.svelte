<script lang="ts">
  import type { CardView } from "./planBoard";
  import BoardCard from "./BoardCard.svelte";
  import type { Label } from "./kanban";
  import { dragState, dropHold, buildDisplaySlots } from "./kanbanDrag";
  import { AUTO_COLUMN_PREFIX } from "./planDrop";
  import { tooltip } from "./tooltip";
  import { flip } from "svelte/animate";

  interface Props {
    status: string;
    planCards: CardView[];
    labels?: Label[];
    workspaceId?: string | null;
    onOpenPlan: (path: string) => void;
    onRunCard?: ((card: CardView) => void) | null;
    onDeleteCard?: ((card: CardView) => void) | null;
    onCardContextMenu?: ((card: CardView, e: MouseEvent) => void) | null;
  }
  let {
    status,
    planCards,
    labels = [],
    workspaceId = null,
    onOpenPlan,
    onRunCard = null,
    onDeleteCard = null,
    onCardContextMenu = null,
  }: Props = $props();

  const key = $derived(AUTO_COLUMN_PREFIX + status);
  const slotDrag = $derived($dragState ?? $dropHold);
  const slots = $derived(buildDisplaySlots(planCards, (p) => p.id, slotDrag, key));
</script>

<!-- Same geometry as KanbanColumn's .column, muted + dashed: these exist
     only so no plan with an unmatched status can ever be invisible. -->
<div class="auto-column" data-kb-col={key} data-kb-auto>
  <div class="auto-header" use:tooltip={"Auto column — cards whose status matches no real column"}>
    {status}<span class="count">{planCards.length}</span>
  </div>
  <div class="cards" data-kb-cards>
    {#each slots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id} data-kb-kind={slot.item.kind} data-kb-ctx={slot.item.contextFolder}>
            <BoardCard card={slot.item} labelDefs={labels} onOpen={onOpenPlan} {workspaceId} onRun={onRunCard} onDelete={onDeleteCard} onContextMenu={onCardContextMenu} />
          </div>
        {:else}
          <div class="slot-placeholder" data-kb-ph style:height="{slotDrag?.size?.height ?? 40}px"></div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .auto-column {
    background: var(--surface-raised);
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    max-height: 100%;
    font-family: monospace;
    box-sizing: border-box;
  }
  .auto-header {
    color: var(--text-muted);
    font-size: 0.85em;
    margin-bottom: 8px;
    user-select: none;
    -webkit-user-select: none;
  }
  .count {
    color: var(--text-subtle);
    font-size: 0.9em;
    margin-left: 6px;
  }
  .cards {
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .slot-placeholder {
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    background: var(--surface-sunken);
    margin-bottom: 6px;
    box-sizing: border-box;
  }
</style>
