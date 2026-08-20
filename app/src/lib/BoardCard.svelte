<script lang="ts">
  import type { Label } from "./kanban";
  import { slugStatus, type CardView } from "./planBoard";
  import { FileText, TriangleAlert, StickyNote, Play, ChevronRight, ChevronDown } from "@lucide/svelte";
  import { dragState, dropHold, buildNestedSlots } from "./kanbanDrag";
  import { kanbanState, cardSessionFor } from "./kanbanState";
  import { layoutState } from "./layoutState";
  import { findSessionLocation } from "./workspace";
  // Svelte 5 self-import for the nested-children recursion.
  import BoardCardSelf from "./BoardCard.svelte";

  interface Props {
    card: CardView;
    // The board's label vocabulary (name + color); card labels reference
    // it by slug-matched name, unknown names render plain (spec §1).
    labelDefs: Label[];
    onOpen: (path: string) => void;
    nested?: boolean;
    // Enables the session dot + Run affordance (absent in the preview).
    workspaceId?: string | null;
    onRun?: ((card: CardView) => void) | null;
  }
  let { card, labelDefs, onOpen, nested = false, workspaceId = null, onRun = null }: Props = $props();

  // Live session binding (card-model spec §3) -- same dot vocabulary the
  // terminal tabs use, plus a distinct exited ring since a card can stay
  // bound to a long-gone session.
  const binding = $derived(
    workspaceId !== null ? cardSessionFor($kanbanState[workspaceId], card.id) : null
  );
  const sessionDot = $derived.by(() => {
    if (!binding) return null;
    const location = findSessionLocation($layoutState, binding.sessionId);
    const status = location ? $layoutState.sessionStatusById[binding.sessionId] : undefined;
    if (status === "working") return { cls: "status-working", title: "Working" };
    if (status === "waiting_for_input") return { cls: "status-waiting", title: "Requests attention" };
    if (location) return { cls: "status-idle", title: "Idle" };
    return { cls: "status-exited", title: "Session exited" };
  });
  const runnable = $derived(onRun !== null && card.kind !== "note" && binding === null);

  let expanded = $state(false);

  // Auto-expand while this plan is the drag's nest target (spec §2) --
  // during the drag AND while the drop's writes are in flight.
  const slotDrag = $derived($dragState ?? $dropHold);
  const nestTargeted = $derived(card.kind === "plan" && slotDrag?.target?.nest === card.id);
  const effectiveExpanded = $derived(expanded || nestTargeted);
  const nestedSlots = $derived(
    card.kind === "plan" ? buildNestedSlots(card.nestedChildren, (c) => c.id, slotDrag, card.id) : []
  );

  const labelChips = $derived(
    card.labels.map((name) => ({
      name,
      color: labelDefs.find((l) => slugStatus(l.name) === slugStatus(name))?.color ?? null,
    }))
  );

  // Pointer-driven opening/dragging lives in kanbanDragGlue (click-vs-
  // drag threshold); this covers the keyboard path only.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(card.id);
    }
  }

  // The chevron short-circuits the board glue: its press must not begin
  // a drag candidate on the card.
  function shield(event: PointerEvent): void {
    event.stopPropagation();
  }
</script>

<div
  class="card kind-{card.kind}"
  class:nested
  role="button"
  tabindex="0"
  onkeydown={handleKeydown}
>
  <div class="header">
    <span class="glyph" title={card.kind}>
      {#if card.kind === "note"}<StickyNote size={11} />{:else if card.kind === "task"}<Play
          size={11}
        />{:else}<FileText size={11} />{/if}
    </span>
    {#if card.priority && card.priority !== "none"}
      <span class="priority priority-{card.priority}" title="Priority: {card.priority}"></span>
    {/if}
    {#if card.kind === "plan" && card.checklistTotal > 0}
      <span class="progress" title="Checklist progress">{card.checklistDone}/{card.checklistTotal}</span>
    {/if}
    {#if sessionDot}
      <span class="status-dot {sessionDot.cls}" title={sessionDot.title}></span>
    {/if}
    {#if card.parseWarning}
      <span class="warning" title="This card's frontmatter has issues"><TriangleAlert size={11} /></span>
    {/if}
    {#if runnable}
      <button
        type="button"
        class="run"
        title="Run with the workspace agent"
        onpointerdown={shield}
        onclick={(e) => {
          e.stopPropagation();
          onRun?.(card);
        }}
      >
        <Play size={11} />
      </button>
    {/if}
    {#if card.kind === "plan" && (card.nestedChildren.length > 0 || nestTargeted)}
      <button
        type="button"
        class="chevron"
        title="{expanded ? 'Collapse' : 'Expand'} {card.nestedChildren.length} nested tasks"
        onpointerdown={shield}
        onclick={(e) => {
          e.stopPropagation();
          expanded = !expanded;
        }}
      >
        {#if expanded}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
        <span class="child-count">{card.nestedChildren.length}</span>
      </button>
    {/if}
  </div>
  <div class="title">{card.title}</div>
  {#if card.parent}
    <span class="parent-chip" class:broken={card.parentBroken} title={card.parentBroken ? `parent: ${card.parent} (not found)` : `Part of ${card.parentTitle}`}>
      {card.parentBroken ? `⚠ ${card.parent}` : card.parentTitle}
    </span>
  {/if}
  {#if labelChips.length > 0}
    <div class="labels">
      {#each labelChips as chip (chip.name)}
        <span class="label-chip" style:border-color={chip.color}>{chip.name}</span>
      {/each}
    </div>
  {/if}
  {#if !nested}
    <div class="context-badge" title={card.id}>{card.contextName}</div>
  {/if}
  {#if card.kind === "plan" && effectiveExpanded && nestedSlots.length > 0}
    <div class="nested-area" data-kb-nest={card.id}>
      {#each nestedSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id} data-kb-kind={slot.item.kind} data-kb-ctx={slot.item.contextFolder}>
            <BoardCardSelf card={slot.item} {labelDefs} {onOpen} nested={true} {workspaceId} {onRun} />
          </div>
        {:else}
          <div class="nested-placeholder" data-kb-ph style:height="{slotDrag?.size?.height ?? 30}px"></div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .card {
    border-radius: 6px;
    padding: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    color: #eee;
    font-family: monospace;
    font-size: 0.85em;
    user-select: none;
    -webkit-user-select: none;
    transition: box-shadow 120ms, border-color 120ms;
  }
  .card.kind-note {
    background: #2a2a2a;
    border: 1px solid #444;
  }
  .card.kind-task {
    background: #26292e;
    border: 1px dashed #4a5568;
  }
  .card.kind-plan {
    background: #262b26;
    border: 1px dashed #4c584c;
  }
  .card:hover {
    border-color: #6a6a6a;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .card.nested {
    margin-bottom: 4px;
    padding: 6px;
    font-size: 0.95em;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .glyph {
    display: flex;
    align-items: center;
    color: #8bc98b;
  }
  .kind-task .glyph {
    color: #7ea8d8;
  }
  .kind-note .glyph {
    color: #b8a978;
  }
  .priority {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .priority-low {
    background: #6b8e6b;
  }
  .priority-medium {
    background: #d9a648;
  }
  .priority-high {
    background: #d97748;
  }
  .priority-urgent {
    background: #d94848;
  }
  .progress {
    color: #999;
    font-size: 0.85em;
  }
  .warning {
    display: flex;
    align-items: center;
    color: #d9a648;
    margin-left: auto;
  }
  .chevron {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
    padding: 0 2px;
  }
  .warning + .chevron {
    margin-left: 0;
  }
  .child-count {
    font-size: 0.8em;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .status-dot.status-working {
    background: #4a9eff;
  }
  .status-dot.status-waiting {
    background: #e0524a;
  }
  .status-dot.status-idle {
    background: #6b8e6b;
  }
  .status-dot.status-exited {
    background: transparent;
    border: 1px solid #666;
  }
  .run {
    background: transparent;
    border: none;
    color: #7ea8d8;
    cursor: pointer;
    display: flex;
    align-items: center;
    padding: 0 2px;
    opacity: 0;
    transition: opacity 120ms;
  }
  .card:hover .run,
  .card:focus-within .run {
    opacity: 1;
  }
  .title {
    word-break: break-word;
  }
  .parent-chip {
    display: inline-block;
    border: 1px solid #4a5568;
    border-radius: 10px;
    padding: 0 6px;
    font-size: 0.8em;
    color: #7ea8d8;
    margin-top: 6px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .parent-chip.broken {
    border-color: #a15c2f;
    color: #e0b08a;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .label-chip {
    border: 1px solid #666;
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.85em;
  }
  .context-badge {
    display: inline-block;
    border: 1px solid #555;
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.8em;
    color: #999;
    margin-top: 6px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .kind-plan .context-badge {
    color: #8bc98b;
    border-color: #4c584c;
  }
  .nested-area {
    margin-top: 8px;
    padding: 6px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.25);
  }
  .nested-placeholder {
    border: 1px dashed #555;
    border-radius: 6px;
    background: #202020;
    margin-bottom: 4px;
    box-sizing: border-box;
  }
</style>
