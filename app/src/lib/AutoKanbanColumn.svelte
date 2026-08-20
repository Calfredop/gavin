<script lang="ts">
  import type { CardView } from "./planBoard";
  import BoardCard from "./BoardCard.svelte";
  import type { Label } from "./kanban";
  import { dragState, dropHold, buildDisplaySlots } from "./kanbanDrag";
  import { AUTO_COLUMN_PREFIX } from "./planDrop";
  import { flip } from "svelte/animate";

  interface Props {
    status: string;
    planCards: CardView[];
    labels?: Label[];
    onOpenPlan: (path: string) => void;
  }
  let { status, planCards, labels = [], onOpenPlan }: Props = $props();

  const key = $derived(AUTO_COLUMN_PREFIX + status);
  const slotDrag = $derived($dragState ?? $dropHold);
  const slots = $derived(buildDisplaySlots(planCards, (p) => p.id, slotDrag, key, "plan"));
</script>

<!-- Same geometry as KanbanColumn's .column, muted + dashed: these exist
     only so no plan with an unmatched status can ever be invisible. -->
<div class="auto-column" data-kb-col={key} data-kb-auto>
  <div class="auto-header" title="Status not matching any column">
    {status}<span class="count">{planCards.length}</span>
  </div>
  <div class="cards" data-kb-cards>
    {#each slots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id}>
            <BoardCard card={slot.item} labelDefs={labels} onOpen={onOpenPlan} />
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
    background: #232323;
    border: 1px dashed #555;
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
    color: #bbb;
    font-size: 0.85em;
    margin-bottom: 8px;
    user-select: none;
    -webkit-user-select: none;
  }
  .count {
    color: #888;
    font-size: 0.9em;
    margin-left: 6px;
  }
  .cards {
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .slot-placeholder {
    border: 1px dashed #555;
    border-radius: 6px;
    background: #202020;
    margin-bottom: 6px;
    box-sizing: border-box;
  }
</style>
